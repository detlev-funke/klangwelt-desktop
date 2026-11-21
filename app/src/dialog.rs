//! The operating system's file picker for opening a project file. Klangwelt's
//! own Open dialog lists the project folder; its "Choose file…" button reaches
//! a .klangwelt file anywhere else through this. Without a third-party crate:
//! Windows through comdlg32, macOS and Linux through the system's own helper
//! programs (as "Show in folder" does).
//!
//! `KLANGWELT_FAKE_FILE_PICK=<path>`: no dialog – the picker answers with this
//! path at once (automated tests can't click in a native dialog).

use std::path::Path;

/// Asks for a .klangwelt file; `None` when cancelled. Blocks until the dialog
/// closes – call it off the main thread. `owner`: the window handle (Windows)
/// the dialog is modal to.
pub fn pick_project(owner: Option<isize>, start_dir: &Path, title: &str, filter_name: &str) -> Result<Option<String>, String> {
    if let Some(p) = std::env::var_os("KLANGWELT_FAKE_FILE_PICK").filter(|v| !v.is_empty()) {
        return Ok(Some(p.to_string_lossy().into_owned()));
    }
    platform::pick(owner, start_dir, title, filter_name).map_err(|e| klang_i18n::tr!("Could not open the file dialog: {error}", error = e))
}

#[cfg(windows)]
mod platform {
    use std::ffi::{c_void, OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;

    /// OPENFILENAMEW (commdlg.h).
    #[repr(C)]
    struct OpenFileName {
        struct_size: u32,
        owner: *mut c_void,
        instance: *mut c_void,
        filter: *const u16,
        custom_filter: *mut u16,
        max_custom_filter: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_dir: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        file_extension: u16,
        default_ext: *const u16,
        custom_data: isize,
        hook: *mut c_void,
        template_name: *const u16,
        reserved_ptr: *mut c_void,
        reserved: u32,
        flags_ex: u32,
    }

    // the layout Windows expects (sizeof(OPENFILENAMEW): 152 bytes on 64 bit, 88 on 32 bit)
    const _: () = assert!(std::mem::size_of::<OpenFileName>() == if cfg!(target_pointer_width = "64") { 152 } else { 88 });

    #[link(name = "comdlg32")]
    extern "system" {
        fn GetOpenFileNameW(ofn: *mut OpenFileName) -> i32;
        fn CommDlgExtendedError() -> u32;
    }

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
    }

    const OFN_HIDEREADONLY: u32 = 0x4;
    const OFN_NOCHANGEDIR: u32 = 0x8;
    const OFN_PATHMUSTEXIST: u32 = 0x800;
    const OFN_FILEMUSTEXIST: u32 = 0x1000;
    const OFN_EXPLORER: u32 = 0x80000;
    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;

    fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
        s.as_ref().encode_wide().chain(Some(0)).collect()
    }

    pub fn pick(owner: Option<isize>, start_dir: &Path, title: &str, filter_name: &str) -> Result<Option<String>, String> {
        // The dialog gets a thread of its own: an apartment for the shell's COM
        // objects, nothing else running on it
        let start_dir = start_dir.to_path_buf();
        let (title, filter_name) = (title.to_owned(), filter_name.to_owned());
        std::thread::Builder::new()
            .name("klang-file-dialog".into())
            .spawn(move || {
                // SAFETY: plain Win32 calls; every pointer in `ofn` points into
                // buffers that live until the call returns.
                unsafe {
                    let com = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
                    // pairs of label and pattern, each NUL-terminated, a NUL at the end
                    let filter: Vec<u16> = format!("{filter_name} (*.klangwelt)\0*.klangwelt\0").encode_utf16().chain([0]).collect();
                    let title = wide(&title);
                    let dir = wide(&start_dir);
                    let mut file = vec![0u16; 32768];
                    let mut ofn: OpenFileName = std::mem::zeroed();
                    ofn.struct_size = std::mem::size_of::<OpenFileName>() as u32;
                    ofn.owner = owner.unwrap_or(0) as *mut c_void;
                    ofn.filter = filter.as_ptr();
                    ofn.filter_index = 1;
                    ofn.file = file.as_mut_ptr();
                    ofn.max_file = file.len() as u32;
                    ofn.initial_dir = if start_dir.is_dir() { dir.as_ptr() } else { std::ptr::null() };
                    ofn.title = title.as_ptr();
                    ofn.flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY | OFN_NOCHANGEDIR;
                    let ok = GetOpenFileNameW(&mut ofn) != 0;
                    let error = if ok { 0 } else { CommDlgExtendedError() };
                    if com >= 0 {
                        CoUninitialize();
                    }
                    if ok {
                        let len = file.iter().position(|&c| c == 0).unwrap_or(file.len());
                        Ok(Some(OsString::from_wide(&file[..len]).to_string_lossy().into_owned()))
                    } else if error == 0 {
                        Ok(None) // cancelled
                    } else {
                        Err(format!("CommDlgExtendedError 0x{error:X}"))
                    }
                }
            })
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|_| "file dialog thread failed".to_owned())?
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::Path;
    use std::process::Command;

    /// A string as an AppleScript literal.
    fn quoted(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub fn pick(_owner: Option<isize>, start_dir: &Path, title: &str, _filter_name: &str) -> Result<Option<String>, String> {
        let mut script = format!("POSIX path of (choose file with prompt {} of type {{\"klangwelt\"}}", quoted(title));
        if start_dir.is_dir() {
            script += &format!(" default location (POSIX file {})", quoted(&start_dir.to_string_lossy()));
        }
        script.push(')');
        let out = Command::new("osascript").arg("-e").arg(script).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim_end_matches(['\r', '\n']).to_owned();
            return Ok((!path.is_empty()).then_some(path));
        }
        let err = String::from_utf8_lossy(&out.stderr);
        // -128: "User canceled."
        if err.contains("-128") {
            Ok(None)
        } else {
            Err(err.trim().to_owned())
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use std::path::Path;
    use std::process::{Command, Output};

    /// The path the helper printed; exit code 1 means cancelled.
    fn answer(out: Output) -> Result<Option<String>, String> {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim_end_matches(['\r', '\n']).to_owned();
            Ok((!path.is_empty()).then_some(path))
        } else if out.status.code() == Some(1) {
            Ok(None)
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
        }
    }

    /// zenity (GNOME and most desktops), otherwise kdialog (KDE).
    pub fn pick(_owner: Option<isize>, start_dir: &Path, title: &str, filter_name: &str) -> Result<Option<String>, String> {
        let mut dir = start_dir.to_string_lossy().into_owned();
        if !dir.ends_with('/') {
            dir.push('/');
        }
        let zenity = Command::new("zenity")
            .arg("--file-selection")
            .arg(format!("--title={title}"))
            .arg(format!("--file-filter={filter_name} (*.klangwelt) | *.klangwelt"))
            .arg(format!("--filename={dir}"))
            .output();
        match zenity {
            Ok(out) => answer(out),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let out = Command::new("kdialog")
                    .arg("--title")
                    .arg(title)
                    .arg("--getopenfilename")
                    .arg(&dir)
                    .arg(format!("*.klangwelt|{filter_name}"))
                    .output()
                    .map_err(|e| format!("zenity, kdialog: {e}"))?;
                answer(out)
            }
            Err(e) => Err(e.to_string()),
        }
    }
}
