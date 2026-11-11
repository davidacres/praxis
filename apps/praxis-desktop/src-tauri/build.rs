fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../renderer/dist");
    println!("cargo:rerun-if-changed=../renderer/dist/index.html");
    println!("cargo:rerun-if-changed=../renderer/dist/tauri.html");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["praxis_rpc"])),
    )
    .expect("build Tauri application");
}
