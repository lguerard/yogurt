//! Linux: who records from a microphone (PulseAudio, or PipeWire through pipewire-pulse), running programs (/proc)
//! and window titles (X11 / XWayland). Yogurt runs under XWayland, so it sees other XWayland and X11 windows; a
//! browser running as a native Wayland client has no title here (null), and so no browser-call offer.

use crate::parse::{self, MicApp, Stream};
use libpulse_binding as pulse;
use pulse::callbacks::ListResult;
use pulse::context::introspect::{SourceInfo, SourceOutputInfo};
use pulse::context::{Context, FlagSet, State};
use pulse::mainloop::standard::{IterateResult, Mainloop};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt, MapState, Window, WindowClass};

/** Monitor sources (a speaker's sound) and every recording stream, from the sound server */
fn pulse_streams() -> Result<(HashSet<u32>, Vec<Stream>), String> {
    let mut ml = Mainloop::new().ok_or("no main loop")?;
    let mut ctx = Context::new(&ml, "yogurt-system").ok_or("no context")?;
    // never start a sound server just to ask it
    ctx.connect(None, FlagSet::NOAUTOSPAWN, None).map_err(|e| format!("no sound server: {e}"))?;
    fn turn(ml: &mut Mainloop) -> Result<(), String> {
        match ml.iterate(true) {
            IterateResult::Success(_) => Ok(()),
            _ => Err("sound server loop ended".to_string()),
        }
    }
    loop {
        turn(&mut ml)?;
        match ctx.get_state() {
            State::Ready => break,
            State::Failed | State::Terminated => return Err("no sound server".into()),
            _ => {}
        }
    }
    let monitors = Rc::new(RefCell::new(HashSet::new()));
    let streams = Rc::new(RefCell::new(Vec::new()));
    let intro = ctx.introspect();
    let m = monitors.clone();
    let sources = intro.get_source_info_list(move |r: ListResult<&SourceInfo>| {
        if let ListResult::Item(s) = r {
            if s.monitor_of_sink.is_some() {
                m.borrow_mut().insert(s.index);
            }
        }
    });
    let o = streams.clone();
    let outputs = intro.get_source_output_info_list(move |r: ListResult<&SourceOutputInfo>| {
        if let ListResult::Item(s) = r {
            let props = parse::PULSE_KEYS.iter().filter_map(|k| s.proplist.get_str(k).map(|v| (k.to_string(), v))).collect();
            o.borrow_mut().push(Stream { source: s.source, corked: s.corked, props });
        }
    });
    while sources.get_state() == pulse::operation::State::Running || outputs.get_state() == pulse::operation::State::Running {
        turn(&mut ml)?;
    }
    ctx.disconnect();
    let monitors = std::mem::take(&mut *monitors.borrow_mut());
    let streams = std::mem::take(&mut *streams.borrow_mut());
    Ok((monitors, streams))
}

fn flatpak_of(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    parse::flatpak_of_cgroup(&std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?)
}

pub fn mic_apps() -> Vec<MicApp> {
    // a sound server that never answers must not hold up the caller
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(4));
        eprintln!("the sound server did not answer");
        std::process::exit(1)
    });
    match pulse_streams() {
        Ok((monitors, streams)) => parse::pulse_apps(&streams, &monitors, flatpak_of),
        Err(e) => {
            eprintln!("{e}");
            Vec::new()
        }
    }
}

/** Every name a process goes by: its program file, its short name, argv[0], and its Flatpak app id */
fn names_of(pid: u32) -> Vec<String> {
    let dir = format!("/proc/{pid}");
    let mut names = Vec::new();
    if let Ok(target) = std::fs::read_link(format!("{dir}/exe")) {
        names.push(parse::exe_base(&target.to_string_lossy()));
    }
    if let Ok(comm) = std::fs::read_to_string(format!("{dir}/comm")) {
        names.push(comm.trim_end().to_string());
    }
    if let Some(argv0) = std::fs::read(format!("{dir}/cmdline")).ok().and_then(|c| parse::argv0_base(&c)) {
        names.push(argv0);
    }
    if let Some(id) = flatpak_of(pid) {
        names.push(id);
    }
    names
}

fn pids() -> Vec<u32> {
    std::fs::read_dir("/proc").map(|d| d.flatten().filter_map(|e| e.file_name().to_str()?.parse().ok()).collect()).unwrap_or_default()
}

pub fn running_apps(ids: &[String]) -> Vec<String> {
    let names: HashSet<String> = pids().into_iter().flat_map(names_of).collect();
    ids.iter().filter(|id| names.contains(id.as_str())).cloned().collect()
}

fn atom(conn: &impl Connection, name: &[u8]) -> Option<Atom> {
    Some(conn.intern_atom(false, name).ok()?.reply().ok()?.atom)
}

fn prop32(conn: &impl Connection, window: Window, property: Atom, kind: impl Into<Atom>) -> Vec<u32> {
    conn.get_property(false, window, property, kind, 0, 4096)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect()))
        .unwrap_or_default()
}

fn prop_text(conn: &impl Connection, window: Window, property: Atom, kind: impl Into<Atom>) -> Option<String> {
    let r = conn.get_property(false, window, property, kind, 0, 1024).ok()?.reply().ok()?;
    (!r.value.is_empty()).then(|| String::from_utf8_lossy(&r.value).into_owned())
}

/** The app's active window title, else its topmost one, from the window manager's client list */
pub fn window_title(id: &str) -> Option<String> {
    let (conn, screen) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen)?.root;
    let net_pid = atom(&conn, b"_NET_WM_PID")?;
    let net_name = atom(&conn, b"_NET_WM_NAME")?;
    let utf8 = atom(&conn, b"UTF8_STRING")?;
    // the stacking list runs bottom to top
    let mut windows = prop32(&conn, root, atom(&conn, b"_NET_CLIENT_LIST_STACKING")?, AtomEnum::WINDOW);
    if windows.is_empty() {
        windows = prop32(&conn, root, atom(&conn, b"_NET_CLIENT_LIST")?, AtomEnum::WINDOW);
    }
    windows.reverse();
    let active = prop32(&conn, root, atom(&conn, b"_NET_ACTIVE_WINDOW")?, AtomEnum::WINDOW).first().copied().filter(|w| *w != 0);
    let found: Vec<(u64, bool, String)> = windows
        .into_iter()
        .map(|w| {
            let pid = prop32(&conn, w, net_pid, AtomEnum::CARDINAL).first().copied().unwrap_or(0);
            let mine = pid != 0 && names_of(pid).iter().any(|n| n == id);
            let title = if mine {
                prop_text(&conn, w, net_name, utf8).or_else(|| prop_text(&conn, w, AtomEnum::WM_NAME.into(), AtomEnum::STRING)).unwrap_or_default()
            } else {
                String::new()
            };
            (w as u64, mine, title)
        })
        .collect();
    parse::pick_window(&found, active.map(|w| w as u64))
}

/**
 * The call apps' windows big enough to take slides of, shown on screen, with where they are (root coordinates). The
 * window manager's list first; then the screen's own top-level windows, since a window the manager left alone is not
 * on that list: KDE does not frame Zoom's call window ("Meeting", _KDE_NET_WM_WINDOW_TYPE_OVERRIDE), and Electron's
 * own window list skips it. A window matches by its process (_NET_WM_PID, as browser-title) or else its WM_CLASS.
 */
pub fn app_windows(ids: &[String]) -> Vec<parse::AppWindow> {
    let Ok((conn, screen)) = x11rb::connect(None) else { return Vec::new() };
    let Some(root) = conn.setup().roots.get(screen).map(|s| s.root) else { return Vec::new() };
    let (Some(net_pid), Some(net_name), Some(utf8)) = (atom(&conn, b"_NET_WM_PID"), atom(&conn, b"_NET_WM_NAME"), atom(&conn, b"UTF8_STRING")) else {
        return Vec::new();
    };
    let managed = [b"_NET_CLIENT_LIST_STACKING".as_slice(), b"_NET_CLIENT_LIST".as_slice()]
        .iter()
        .filter_map(|name| atom(&conn, name))
        .map(|a| prop32(&conn, root, a, AtomEnum::WINDOW))
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let top: Vec<Window> = conn.query_tree(root).ok().and_then(|c| c.reply().ok()).map(|r| r.children).unwrap_or_default();
    let managed_set: HashSet<Window> = managed.iter().copied().collect();
    let mut names: HashMap<u32, Vec<String>> = HashMap::new();
    let mut found = Vec::new();
    for w in parse::unique_windows(&[managed, top]) {
        let Some(attrs) = conn.get_window_attributes(w).ok().and_then(|c| c.reply().ok()) else { continue };
        if attrs.map_state != MapState::VIEWABLE || attrs.class == WindowClass::INPUT_ONLY {
            continue;
        }
        let Some(geo) = conn.get_geometry(w).ok().and_then(|c| c.reply().ok()) else { continue };
        if !parse::big_enough(geo.width.into(), geo.height.into()) {
            continue;
        }
        let pid = prop32(&conn, w, net_pid, AtomEnum::CARDINAL).first().copied().unwrap_or(0);
        let by_pid = (pid != 0)
            .then(|| {
                let of = names.entry(pid).or_insert_with(|| names_of(pid));
                ids.iter().find(|id| of.contains(id)).cloned()
            })
            .flatten();
        let app = by_pid.or_else(|| {
            let class = conn.get_property(false, w, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256).ok()?.reply().ok()?;
            parse::wm_class_app(&class.value, ids).cloned()
        });
        let Some(app) = app else { continue };
        // a top-level window the manager did not list can be its frame around a client it did list: that client is the window
        if !managed_set.contains(&w) {
            let children = conn.query_tree(w).ok().and_then(|c| c.reply().ok()).map(|r| r.children).unwrap_or_default();
            if children.iter().any(|c| managed_set.contains(c)) {
                continue;
            }
        }
        let Some(at) = conn.translate_coordinates(w, root, 0, 0).ok().and_then(|c| c.reply().ok()) else { continue };
        let title = prop_text(&conn, w, net_name, utf8).or_else(|| prop_text(&conn, w, AtomEnum::WM_NAME.into(), AtomEnum::STRING)).unwrap_or_default();
        found.push(parse::AppWindow { id: w as u64, app, title, x: at.dst_x.into(), y: at.dst_y.into(), w: geo.width.into(), h: geo.height.into() });
    }
    found
}
