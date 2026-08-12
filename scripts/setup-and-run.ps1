Write-Host "Downloading rustup-init..."
Invoke-WebRequest -Uri https://win.rustup.rs -OutFile rustup-init.exe
Write-Host "Installing rust..."
.\rustup-init.exe -y --default-toolchain stable
$env:PATH += ";$HOME\.cargo\bin"
Write-Host "Installing tauri-cli..."
cargo install tauri-cli --version "^2" --locked
Write-Host "Starting app..."
cargo tauri dev
