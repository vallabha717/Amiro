$env:BETTERCHATBOT_DATABASE_DRIVER="sqlite"
$env:BETTERCHATBOT_APP_DATA_DIR="$env:USERPROFILE\.local\share\better-chatbot-dev"
$env:BETTERCHATBOT_PORT="8787"
$env:BETTERCHATBOT_AUTH_TOKEN="dev-test-token-1786373638"
$env:BETTERCHATBOT_ALLOWED_ORIGIN="http://localhost:3210"

$envFile = "$PSScriptRoot\..\.env"
if (Test-Path $envFile) {
    $envContent = Get-Content $envFile
    foreach ($line in $envContent) {
        if ($line.StartsWith("OPENAI_COMPATIBLE_DATA=")) {
            # The .env value is quoted (the JSON contains spaces and shell
            # metacharacters); pass the JSON itself through, not the quotes,
            # or the Go side's json.Unmarshal chokes on the leading quote and
            # drops every custom provider.
            $value = $line.Substring("OPENAI_COMPATIBLE_DATA=".Length).Trim()
            if ($value.Length -ge 2) {
                $q = $value[0]
                if (($q -eq "'" -or $q -eq '"') -and $value[$value.Length - 1] -eq $q) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
            }
            $env:OPENAI_COMPATIBLE_DATA = $value
            break
        }
    }
}

New-Item -ItemType Directory -Force -Path $env:BETTERCHATBOT_APP_DATA_DIR | Out-Null
Set-Location "$PSScriptRoot\..\backend-go"
go run .\cmd\server
