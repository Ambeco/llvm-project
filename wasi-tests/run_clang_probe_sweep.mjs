// Sweeps a corpus of small programs through clang.wasm + lld.wasm against the packaged sysroot, to find
// compiler<->runtime-library mismatches (e.g. the wasm EH personality rename). Each probe is compiled, linked and
// run on a stock WASI host; the same probe is also built with wasi-sdk's own clang as a reference, so a failure
// that also happens in the reference is the probe's/host's fault and not a version mismatch.
//
// Usage:
// (--bin must hold a plain, non-threaded clang.wasm/lld.wasm; --threads only selects the output slice.)
//   node --experimental-wasm-type-reflection --experimental-wasi-unstable-preview1 \
//     wasi-tests/run_clang_probe_sweep.mjs <release-dir> [--bin <dir>] [--threads] [--only <substr>] [--no-reference]
// Verdicts per probe: PASS, COMPILE/LINK/RUN fail, with `ref=PASS|FAIL`. Exit 1 if any probe fails where the reference passes.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { WASI } from 'node:wasi';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { argv } from 'node:process';
import { findResourceDir } from './wasi_spawn_shim.mjs';
import { instantiateThreaded, makeFakeInstance } from './wasi_thread_hook.mjs';

const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const threads = argv.includes('--threads');
const only = opt('--only');
const useRef = !argv.includes('--no-reference');
const positional = argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--bin', '--only'].includes(all[i - 1]));
if (!positional[0]) throw new Error('usage: run_clang_probe_sweep.mjs <release-dir> [--bin dir] [--threads] [--only substr] [--no-reference]');
const releaseDir = path.resolve(positional[0]);
const binDir = opt('--bin') ? path.resolve(opt('--bin')) : path.join(releaseDir, 'bin');
const wasiSdk = 'C:/Users/mooin/AppData/Local/wasi-sdk/wasi-sdk-34.0-x86_64-windows';
const slice = threads ? 'wasm32-wasip1-threads' : 'wasm32-wasip1';
const resourceDir = await findResourceDir(path.join(releaseDir, 'resource', 'lib', 'clang'));
const workDir = await mkdtemp(path.join(tmpdir(), 'clang-wasm-sweep-'));
const preopens = { '/work': workDir, '/sysroot': path.join(releaseDir, 'sysroot'), '/resource': resourceDir };
const subst = (a) => a.replaceAll('${SYSROOT}', '/sysroot').replaceAll('${RESOURCE}', '/resource');
const flags = JSON.parse(await readFile(path.join(releaseDir, 'compile-flags.json'), 'utf8'));
const compileFlags = flags.compile[slice].map(subst);
const linkFlags = flags.link[slice].map(subst);

const OK = 'int main() { puts("OK"); return 0; }';
const probes = [
  { name: 'iostream', src: '#include <iostream>\nint main(){ std::cout << "OK\\n"; }' },
  { name: 'string-format', std: 'c++20', src: '#include <format>\n#include <string>\n#include <iostream>\nint main(){ std::string s = std::format("{}-{:05.1f}-{:x}", "a", 3.14159, 255); std::cout << (s == "a-003.1-ff" ? "OK" : s) << "\\n"; }' },
  { name: 'print', std: 'c++23', src: '#include <print>\nint main(){ std::println("OK {}", 1); }' },
  { name: 'containers', src: '#include <string>\n#include <map>\n#include <unordered_map>\n#include <deque>\n#include <set>\n#include <algorithm>\n#include <vector>\n#include <cstdio>\nint main(){ std::map<int,int> m; std::unordered_map<std::string,int> u; std::deque<int> d; std::vector<int> v{5,3,1,4}; std::sort(v.begin(), v.end()); for(int i=0;i<1000;i++){ m[i]=i; u[std::to_string(i)]=i; d.push_front(i);} std::puts(v[0]==1 && m.size()==1000 && u.size()==1000 ? "OK":"BAD"); }' },
  { name: 'regex', src: '#include <regex>\n#include <cstdio>\nint main(){ std::regex r("(a+)(b*)c"); std::smatch m; std::string s="xxaabbbcyy"; std::puts(std::regex_search(s,m,r) && m[1]=="aa" ? "OK":"BAD"); }' },
  { name: 'random-chrono', src: '#include <random>\n#include <chrono>\n#include <cstdio>\nint main(){ std::mt19937 g(1); std::uniform_int_distribution<int> d(1,6); auto t=std::chrono::steady_clock::now(); int x=d(g); auto e=std::chrono::steady_clock::now()-t; std::puts(x>=1&&x<=6&&e.count()>=0 ? "OK":"BAD"); }' },
  { name: 'sstream-locale', src: '#include <sstream>\n#include <iomanip>\n#include <locale>\n#include <cstdio>\nint main(){ std::ostringstream o; o.imbue(std::locale::classic()); o << std::fixed << std::setprecision(3) << 3.14159 << " " << std::hex << 255; std::puts(o.str()=="3.142 ff" ? "OK":"BAD"); }' },
  { name: 'filesystem', src: '#include <filesystem>\n#include <cstdio>\nint main(){ std::filesystem::path p("/a/b/c.txt"); std::puts(p.filename()=="c.txt" && p.parent_path()=="/a/b" ? "OK":"BAD"); }' },
  { name: 'smart-ptr-variant', src: '#include <string>\n#include <memory>\n#include <variant>\n#include <optional>\n#include <any>\n#include <cstdio>\nint main(){ auto p=std::make_shared<int>(3); std::variant<int,double> v=2.5; std::optional<int> o=4; std::any a=std::string("x"); std::puts(*p==3 && std::get<double>(v)==2.5 && *o==4 && std::any_cast<std::string>(a)=="x" ? "OK":"BAD"); }' },
  { name: 'ranges', std: 'c++23', src: '#include <ranges>\n#include <vector>\n#include <cstdio>\nint main(){ std::vector<int> v{1,2,3,4}; int s=0; for(int x: v | std::views::filter([](int i){return i%2==0;}) | std::views::transform([](int i){return i*i;})) s+=x; std::puts(s==20 ? "OK":"BAD"); }' },
  { name: 'coroutine', std: 'c++20', src: '#include <coroutine>\n#include <cstdio>\nstruct T{ struct promise_type{ int v; T get_return_object(){return {std::coroutine_handle<promise_type>::from_promise(*this)};} std::suspend_never initial_suspend(){return {};} std::suspend_always final_suspend() noexcept{return {};} void return_value(int x){v=x;} void unhandled_exception(){} }; std::coroutine_handle<promise_type> h; };\nT f(){ co_return 7; }\nint main(){ auto t=f(); std::puts(t.h.promise().v==7 ? "OK":"BAD"); t.h.destroy(); }' },
  { name: 'rtti-virtual', src: '#include <typeinfo>\n#include <cstdio>\nstruct A{ virtual ~A(){} virtual int f(){return 1;} };\nstruct B:A{ int f() override {return 2;} };\nint main(){ A* a=new B; B* b=dynamic_cast<B*>(a); bool ok = b && typeid(*a)==typeid(B) && a->f()==2; delete a; std::puts(ok ? "OK":"BAD"); }' },
  { name: 'static-init-atexit', src: '#include <cstdio>\n#include <cstdlib>\nstruct G{ int v; G():v(5){} ~G(){ std::puts("dtor"); } } g;\nstatic void bye(){ }\nint main(){ std::atexit(bye); std::puts(g.v==5 ? "OK":"BAD"); }' },
  { name: 'long-double-int128', linkExtra: ['-lc-printscan-long-double'], src: '#include <string_view>\n#include <cstdio>\n#include <cmath>\nint main(){ volatile long double a=1.5L, b=2.25L; long double c=a*b+sqrtl(b); __int128 x=(__int128)1<<100; x/=3; char buf[64]; snprintf(buf,64,"%.3Lf",c); std::puts(std::string_view(buf)=="4.875" && (long long)(x>>64)>0 ? "OK":buf); }' },
  { name: 'complex-math', src: '#include <complex>\n#include <cmath>\n#include <cstdio>\nint main(){ std::complex<double> z(1,2); auto w=z*z; volatile double x=0.5; std::puts(w.real()==-3 && std::fabs(std::sin(x)-0.479425538604203)<1e-12 ? "OK":"BAD"); }' },
  { name: 'spaceship-fcmp', std: 'c++20', src: '#include <compare>\n#include <cstdio>\nint main(){ volatile double a=1.0,b=2.0; volatile float c=3,d=3; auto r=a<=>b; auto s=c<=>d; std::puts(r<0 && s==0 ? "OK":"BAD"); }' },
  { name: 'atomics64', src: '#include <atomic>\n#include <cstdio>\nint main(){ std::atomic<long long> a{1}; a.fetch_add(2); long long e=3; a.compare_exchange_strong(e,10); std::atomic<int> i{0}; i++; std::puts(a==10 && i==1 ? "OK":"BAD"); }' },
  { name: 'new-aligned-pmr', std: 'c++17', src: '#include <new>\n#include <memory_resource>\n#include <vector>\n#include <cstdio>\nstruct alignas(64) A{ int x; };\nint main(){ A* a=new A; bool al=((unsigned long)a%64)==0; delete a; std::pmr::monotonic_buffer_resource r; std::pmr::vector<int> v(&r); v.push_back(1); std::puts(al && v.size()==1 ? "OK":"BAD"); }' },
  { name: 'c-libc-setjmp', lang: 'c', src: '#include <stdio.h>\n#include <setjmp.h>\n#include <string.h>\n#include <stdlib.h>\n#include <math.h>\nstatic jmp_buf jb;\nint main(void){ if(setjmp(jb)==0){ longjmp(jb,1); } char b[32]; snprintf(b,32,"%g",1.5); void* p=malloc(10); memset(p,0,10); free(p); puts(strcmp(b,"1.5")==0 ? "OK":"BAD"); return 0; }', note: 'setjmp needs -mllvm -wasm-enable-sjlj in wasi-sdk 34; failure here is informational', flagsExtra: ['-mllvm', '-wasm-enable-sjlj'], linkExtra: ['-lsetjmp'] },
  { name: 'stack-protector-O2', flagsExtra: ['-O2', '-fstack-protector-all'], src: '#include <cstdio>\n#include <cstring>\nint main(int c, char**){ char b[16]; std::memset(b, c, sizeof b); std::puts(b[0]==1 ? "OK":"BAD"); }' },
  { name: 'ubsan-O1', flagsExtra: ['-O1', '-fsanitize=undefined', '-fsanitize-trap=undefined'], src: '#include <cstdio>\nint main(int c, char**){ int a[4]={1,2,3,4}; std::puts(a[c]==2 ? "OK":"BAD"); }' },
  { name: 'thread-mutex-future', needsThreads: true, src: '#include <thread>\n#include <mutex>\n#include <future>\n#include <condition_variable>\n#include <cstdio>\nint main(){ std::mutex m; long n=0; std::thread t([&]{ for(int i=0;i<1000;i++){ std::lock_guard g(m); n++; } }); t.join(); auto f=std::async(std::launch::async, []{ return 21*2; }); std::puts(n==1000 && f.get()==42 ? "OK":"BAD"); }' },
  { name: 'thread-local', needsThreads: true, src: '#include <thread>\n#include <cstdio>\nthread_local int tl=1;\nint main(){ int seen=0; std::thread t([&]{ tl=5; seen=tl; }); t.join(); std::puts(tl==1 && seen==5 ? "OK":"BAD"); }' },
];

// Extra -l libs must precede -lc so they win over libc.a's stubs.
function withExtraBeforeLibc(link, extra) {
  const i = link.indexOf('-lc');
  return i < 0 ? [...link, ...extra] : [...link.slice(0, i), ...extra, ...link.slice(i)];
}

function toolRun(wasmFile, args, errFile) {
  const fd = openSync(errFile, 'w');
  const wasi = new WASI({ version: 'preview1', args, env: {}, preopens, stderr: fd, stdout: fd });
  return WebAssembly.compile(readFileSync(path.join(binDir, wasmFile))).then((m) => WebAssembly.instantiate(m, wasi.getImportObject())).then((inst) => {
    try { return wasi.start(inst) ?? 0; } catch (e) { appendFileSync(errFile, `trapped: ${e}\n`); return -1; } finally { closeSync(fd); }
  });
}
const tail = (file, n = 6) => { try { return readFileSync(file, 'utf8').trim().split('\n').slice(0, n).join(' | ').slice(0, 400); } catch { return ''; } };

async function execWasm(wasmPath, outFile) {
  const fd = openSync(outFile, 'w');
  try {
    const out = await readFile(wasmPath);
    const w = new WASI({ version: 'preview1', args: ['prog'], env: {}, preopens: {}, stdout: fd, stderr: fd });
    let rc;
    if (threads) {
      const { instance, memory } = await instantiateThreaded(await WebAssembly.compile(out), out, w.getImportObject(), { wasmPath, preopens: {} });
      rc = w.start(makeFakeInstance(instance, memory)) ?? 0;
    } else {
      rc = w.start(await WebAssembly.instantiate(await WebAssembly.compile(out), w.getImportObject())) ?? 0;
    }
    return rc;
  } catch (e) { return `trap: ${String(e).slice(0, 200)}`; } finally { closeSync(fd); }
}

async function runOne(p, sdkMode) {
  const isC = p.lang === 'c';
  const ext = isC ? 'c' : 'cpp';
  const base = path.join(workDir, `${p.name}${sdkMode ? '.ref' : ''}`);
  await writeFile(`${base}.${ext}`, p.src);
  const std = p.std ? [`-std=${p.std}`] : [];
  const extra = p.flagsExtra ?? [];
  if (sdkMode) {
    try {
      execFileSync(`${wasiSdk}/bin/clang${isC ? '' : '++'}.exe`, [`--target=${isC ? 'wasm32-wasip1' : 'wasm32-wasip1'}${threads ? '-threads' : ''}`, `--sysroot=${wasiSdk}/share/wasi-sysroot`, ...(threads ? ['-pthread', '-Wl,--import-memory,--shared-memory,--max-memory=2147483648'] : []), ...std, ...(isC ? [] : ['-fno-exceptions']), ...extra, ...(p.linkExtra ?? []), `${base}.${ext}`, '-o', `${base}.wasm`], { stdio: 'pipe' });
    } catch (e) { return `COMPILE/LINK fail: ${String(e.stderr ?? e).split('\n').slice(0, 3).join(' | ').slice(0, 300)}`; }
  } else {
    const guest = `/work/${p.name}`;
    const errF = `${base}.err`;
    const rc = await toolRun('clang.wasm', [isC ? 'clang' : 'clang++', ...compileFlags, ...std, ...extra, '-fno-crash-diagnostics', '-c', `${guest}.${ext}`, '-o', `${guest}.o`], errF);
    if (rc !== 0) return `COMPILE fail (exit ${rc}): ${tail(errF)}`;
    const lrc = await toolRun('lld.wasm', ['wasm-ld', linkFlags[0], `${guest}.o`, ...withExtraBeforeLibc(linkFlags.slice(1), p.linkExtra ?? []), '-o', `${guest}.wasm`], `${base}.lerr`);
    if (lrc !== 0) return `LINK fail (exit ${lrc}): ${tail(`${base}.lerr`)}`;
  }
  const outF = `${base}.out`;
  const rc = await execWasm(`${base}.wasm`, outF);
  const out = tail(outF, 3);
  return rc === 0 && out.includes('OK') ? 'PASS' : `RUN fail (rc=${rc}): ${out}`;
}

let bad = 0, informational = 0;
for (const p of probes) {
  if (only && !p.name.includes(only)) continue;
  if (p.needsThreads && !threads) continue;
  const ours = await runOne(p, false);
  const ref = useRef ? await runOne(p, true) : 'skipped';
  const refOk = ref === 'PASS' || ref === 'skipped';
  const verdict = ours === 'PASS' ? 'PASS' : refOk ? 'FAIL' : 'FAIL(ref also fails)';
  console.log(`${verdict.padEnd(8)} ${p.name}  ref=${ref === 'PASS' ? 'PASS' : ref === 'skipped' ? '-' : 'FAIL'}${ours === 'PASS' ? '' : `\n         ours: ${ours}`}${ours !== 'PASS' && ref !== 'PASS' && ref !== 'skipped' ? `\n         ref:  ${ref}` : ''}`);
  if (ours !== 'PASS') { if (refOk) bad++; else informational++; }
}
console.log(`${bad === 0 ? 'SWEEP PASSED' : 'SWEEP FAILED'} (${bad} mismatch-suspect failures, ${informational} failures that also fail in the reference)`);
process.exit(bad === 0 ? 0 : 1);
