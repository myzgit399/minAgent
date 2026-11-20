//! C ABI bridge that embeds the real grok-build headless agent engine into a
//! host process (minAgent's Electron main process via koffi).
//!
//! No grok.exe / PTY is involved: the agent runtime runs in-process. Output is
//! delivered as newline-delimited lines that the host drains with
//! [`xgrok_poll`] — the engine runs on its OWN thread, so the host's JS thread
//! is never blocked and can paint tokens as they stream in.
//!
//! Call order:
//!   1. `xgrok_init()`                      — once, installs the line queue.
//!   2. `xgrok_run_ex(..)`                  — starts one turn, returns at once.
//!   3. `xgrok_poll(buf, cap)` in a loop    — drains streamed lines.
//!   4. `xgrok_busy()`                      — 1 while the turn is running.
//!
//! Lines are ACP session updates serialised as one JSON object per line
//! (`OutputFormat::StreamingJson`), e.g.
//!   {"type":"text","data":"..."}          streamed assistant text
//!   {"type":"thought","data":"..."}       reasoning
//!   {"type":"tool_call",...}              tool invocation (+ updates)
//!   {"type":"plan"/"error"/...}
//!   {"type":"end","sessionId":"...",...}  terminal line of the turn
//! plus one host-level line per run: {"type":"xgrok_done","ok":bool,...}.

use std::collections::VecDeque;
use std::ffi::{CStr, CString, c_char};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use xai_grok_pager::headless::{
    HeadlessOptions, HeadlessPrompt, OutputFormat, run_single_turn, set_headless_event_sink,
};

/// Max lines buffered while the host polls; oldest are dropped past this.
const QUEUE_LIMIT: usize = 20_000;

static QUEUE: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
static BUSY: AtomicBool = AtomicBool::new(false);
static SINK_INSTALLED: AtomicBool = AtomicBool::new(false);

fn queue() -> &'static Mutex<VecDeque<String>> {
    QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn push_line(line: &str) {
    let mut q = match queue().lock() {
        Ok(q) => q,
        Err(poisoned) => poisoned.into_inner(),
    };
    if q.len() >= QUEUE_LIMIT {
        q.pop_front();
    }
    q.push_back(line.to_string());
}

fn to_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

fn to_json_string(value: serde_json::Value) -> *mut c_char {
    let text = value.to_string();
    CString::new(text).unwrap_or_else(|_| CString::new("{}").unwrap()).into_raw()
}

fn opt(value: &str) -> Option<String> {
    if value.is_empty() { None } else { Some(value.to_string()) }
}

/// Install the in-process line queue (idempotent). Must be called before any
/// run; no host callback is needed because the host polls instead, which keeps
/// every FFI touch on the JS thread and every engine touch on its own thread.
#[unsafe(no_mangle)]
pub extern "C" fn xgrok_init() {
    if SINK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let sink: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|line: &str| push_line(line));
    // `false` => another caller installed one first; the queue still works.
    let _ = set_headless_event_sink(sink);
}

/// Drain queued output lines into `buf` (joined by `\n`, NUL-terminated).
///
/// Returns the number of bytes written (excluding the NUL). `0` means the
/// queue was empty or `cap` is too small for even one line — poll again.
///
/// # Safety
/// `buf` must point to at least `cap` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn xgrok_poll(buf: *mut c_char, cap: i32) -> i32 {
    if buf.is_null() || cap <= 1 {
        return 0;
    }
    let mut q = match queue().lock() {
        Ok(q) => q,
        Err(poisoned) => poisoned.into_inner(),
    };
    if q.is_empty() {
        return 0;
    }

    let limit = (cap - 1) as usize;
    let mut out = String::new();
    while let Some(line) = q.front() {
        let extra = line.len() + if out.is_empty() { 0 } else { 1 };
        if out.len() + extra > limit {
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
        q.pop_front();
    }

    if out.is_empty() {
        return 0;
    }

    let bytes = out.as_bytes();
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, bytes.len());
        *buf.add(bytes.len()) = 0;
    }
    bytes.len() as i32
}

/// 1 while a turn is running, 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn xgrok_busy() -> i32 {
    i32::from(BUSY.load(Ordering::SeqCst))
}

fn build_options(
    model: &str,
    cwd: &str,
    yolo: bool,
    effort: &str,
    resume: &str,
    continue_last: bool,
) -> HeadlessOptions {
    HeadlessOptions {
        session_id: None,
        resume: opt(resume),
        resume_title_pinned: false,
        cwd: if cwd.is_empty() { None } else { Some(std::path::PathBuf::from(cwd)) },
        yolo,
        trust: yolo,
        output_format: OutputFormat::StreamingJson,
        include_partial_messages: false,
        json_schema: None,
        model: opt(model),
        rules: None,
        system_prompt_override: None,
        continue_last_session: continue_last,
        fork_session: false,
        worktree: None,
        worktree_ref: None,
        restore_code: false,
        agent: None,
        agents_json: None,
        cli_tools: None,
        cli_disallowed_tools: None,
        disable_web_search: false,
        allow_rules: Vec::new(),
        deny_rules: Vec::new(),
        max_turns: None,
        permission_mode_flag: None,
        reasoning_effort: opt(effort),
        wait_for_background: false,
        background_wait_timeout: std::time::Duration::from_secs(5),
        memory_flush: false,
        memory_enabled_override: None,
    }
}

/// Apply the host-supplied credential + proxy for this process.
fn apply_env(api_key: &str, proxy: &str) {
    if !api_key.is_empty() {
        xai_grok_login::auth_method::set_runtime_xai_api_key(api_key);
    }
    // grok's HTTP stack honours HTTPS_PROXY/HTTP_PROXY (per-process setting).
    if !proxy.is_empty() {
        unsafe {
            std::env::set_var("HTTPS_PROXY", proxy);
            std::env::set_var("HTTP_PROXY", proxy);
            std::env::set_var("ALL_PROXY", proxy);
        }
    } else {
        unsafe {
            std::env::remove_var("HTTPS_PROXY");
            std::env::remove_var("HTTP_PROXY");
            std::env::remove_var("ALL_PROXY");
        }
    }
}

/// Run one headless turn **on a background thread** and return immediately.
///
/// Parameters:
/// - `api_key`: xAI API key (empty => the engine's stored credential).
/// - `model`: model id (empty => grok default). Applies to this and later turns.
/// - `proxy_url`: HTTP(S) proxy (empty => direct).
/// - `prompt`: the user prompt (grok `/` commands are accepted as text).
/// - `cwd`: working directory for the agent (empty => process cwd).
/// - `yolo`: 1 to auto-approve tool calls.
/// - `effort`: reasoning-effort token (empty => the model's own default).
/// - `resume`: session id to continue (empty => a fresh session).
/// - `continue_last`: 1 to continue the most recent session when `resume` is empty.
///
/// Returns `{"ok":bool,"error"?:string}` for the *start*; the turn's own
/// terminal line arrives on the queue as `{"type":"xgrok_done",...}`.
/// Free the result with `xgrok_free`.
///
/// # Safety
/// All `*const c_char` arguments must be valid NUL-terminated strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn xgrok_run_ex(
    api_key: *const c_char,
    model: *const c_char,
    proxy_url: *const c_char,
    prompt: *const c_char,
    cwd: *const c_char,
    yolo: i32,
    effort: *const c_char,
    resume: *const c_char,
    continue_last: i32,
) -> *mut c_char {
    let api_key = to_string(api_key);
    let model = to_string(model);
    let proxy = to_string(proxy_url);
    let prompt = to_string(prompt);
    let cwd = to_string(cwd);
    let effort = to_string(effort);
    let resume = to_string(resume);
    let continue_last = continue_last != 0;

    if BUSY.swap(true, Ordering::SeqCst) {
        return to_json_string(serde_json::json!({
            "ok": false,
            "error": "grok 正在执行上一轮任务，请等待结束或先停止。",
        }));
    }
    xgrok_init();

    std::thread::spawn(move || {
        apply_env(&api_key, &proxy);
        let options = build_options(&model, &cwd, yolo != 0, &effort, &resume, continue_last);

        let outcome = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(runtime) => runtime
                .block_on(run_single_turn(Some(HeadlessPrompt::Text(prompt)), false, options))
                .map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };

        let line = match outcome {
            Ok(()) => serde_json::json!({"type": "xgrok_done", "ok": true}),
            Err(error) => serde_json::json!({"type": "xgrok_done", "ok": false, "error": error}),
        };
        push_line(&line.to_string());
        BUSY.store(false, Ordering::SeqCst);
    });

    to_json_string(serde_json::json!({"ok": true}))
}

/// Legacy blocking entry point (plain `Json` output, no queue). Kept so an
/// older host build still links; new hosts use `xgrok_run_ex` + `xgrok_poll`.
///
/// # Safety
/// All `*const c_char` arguments must be valid NUL-terminated strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn xgrok_run(
    api_key: *const c_char,
    model: *const c_char,
    proxy_url: *const c_char,
    prompt: *const c_char,
    cwd: *const c_char,
    yolo: i32,
) -> *mut c_char {
    let api_key = to_string(api_key);
    let model = to_string(model);
    let proxy = to_string(proxy_url);
    let prompt = to_string(prompt);
    let cwd = to_string(cwd);

    apply_env(&api_key, &proxy);

    let mut options = build_options(&model, &cwd, yolo != 0, "", "", false);
    options.output_format = OutputFormat::Json;

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return to_json_string(serde_json::json!({"ok": false, "error": e.to_string()})),
    };

    match runtime.block_on(run_single_turn(Some(HeadlessPrompt::Text(prompt)), false, options)) {
        Ok(()) => to_json_string(serde_json::json!({"ok": true})),
        Err(e) => to_json_string(serde_json::json!({"ok": false, "error": e.to_string()})),
    }
}

/// Free a string returned by any `xgrok_*` entry point.
///
/// # Safety
/// `ptr` must be a pointer previously returned by this library and not freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn xgrok_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// Returns the embedded engine version string. Free with `xgrok_free`.
#[unsafe(no_mangle)]
pub extern "C" fn xgrok_version() -> *mut c_char {
    to_json_string(serde_json::json!({"engine": "grok-build", "version": env!("CARGO_PKG_VERSION")}))
}
