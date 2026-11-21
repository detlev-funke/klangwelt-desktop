fn main() {
    // The app version is Klangwelt's (ui/package.json in the submodule, e.g. 2026.11.21+1430):
    // tauri.conf.json points to it, and --version prints it.
    let pkg = "../klangwelt/ui/package.json";
    println!("cargo:rerun-if-changed={pkg}");
    let json = std::fs::read_to_string(pkg).expect("klangwelt/ui/package.json (git submodule update --init)");
    let version = json
        .split_once("\"version\"")
        .and_then(|(_, rest)| rest.split('"').nth(1))
        .expect("version in klangwelt/ui/package.json");
    println!("cargo:rustc-env=KLANGWELT_VERSION={version}");
    tauri_build::build()
}
