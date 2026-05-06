# Tauri signCommand wrapper — invoked by tauri-bundler for every Windows
# artifact that needs an Authenticode signature (the inner exe, the NSIS
# setup.exe, the MSI). Tauri replaces %1 in the configured signCommand with
# the file path; we receive it here as -File.
#
# Behavior:
#   * If Azure Trusted Signing env vars are set (see SIGN_ENV_OK below), sign
#     the file via signtool + the Trusted Signing dlib.
#   * Otherwise, no-op with exit code 0 so unsigned dev builds and forks
#     without signing creds still succeed.
#
# Required env vars (when signing):
#   AZURE_TENANT_ID
#   AZURE_CLIENT_ID
#   AZURE_CLIENT_SECRET
#   AZURE_TRUSTED_SIGNING_ENDPOINT          e.g. https://eus.codesigning.azure.net/
#   AZURE_TRUSTED_SIGNING_ACCOUNT_NAME      Trusted Signing account name
#   AZURE_TRUSTED_SIGNING_CERT_PROFILE_NAME certificate profile within that account
#   AZURE_TRUSTED_SIGNING_DLIB_PATH         absolute path to Azure.CodeSigning.Dlib.dll
#                                           (downloaded once per CI run from NuGet)
#
# Optional:
#   SIGNTOOL_PATH                           override for signtool.exe location
#                                           (defaults to PATH lookup)

param(
  [Parameter(Mandatory = $true)]
  [string]$File
)

$ErrorActionPreference = "Stop"

function Write-Skip([string]$reason) {
  Write-Host "[sign-windows] skip: $reason"
  exit 0
}

# All-or-nothing gate: if ANY required var is missing, skip rather than
# half-sign. Halfway-configured CI is the common failure mode and produces
# confusing errors deep inside signtool.
$required = @(
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERT_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_DLIB_PATH"
)
foreach ($name in $required) {
  if (-not (Test-Path "Env:$name") -or [string]::IsNullOrWhiteSpace((Get-Item "Env:$name").Value)) {
    Write-Skip "$name is not set (signing not configured)"
  }
}

if (-not (Test-Path $File)) {
  Write-Error "[sign-windows] target file does not exist: $File"
  exit 1
}

if (-not (Test-Path $env:AZURE_TRUSTED_SIGNING_DLIB_PATH)) {
  Write-Error "[sign-windows] dlib not found: $env:AZURE_TRUSTED_SIGNING_DLIB_PATH"
  exit 1
}

# signtool reads Azure SP credentials from these env vars via the Trusted
# Signing dlib. They're already in the process env from the calling step;
# we just have to make sure the variable names match what the dlib expects.
$signtool = if ($env:SIGNTOOL_PATH) { $env:SIGNTOOL_PATH } else { "signtool.exe" }

# Per-invocation metadata file: lives next to the dlib so it's picked up by
# /dmdf. CorrelationId is a fresh GUID per signing call so Azure's audit
# logs can pinpoint a specific build.
$metadataDir = Split-Path $env:AZURE_TRUSTED_SIGNING_DLIB_PATH -Parent
$metadataPath = Join-Path $metadataDir "trusted-signing-metadata.json"
$correlationId = [guid]::NewGuid().ToString()
@{
  Endpoint = $env:AZURE_TRUSTED_SIGNING_ENDPOINT
  CodeSigningAccountName = $env:AZURE_TRUSTED_SIGNING_ACCOUNT_NAME
  CertificateProfileName = $env:AZURE_TRUSTED_SIGNING_CERT_PROFILE_NAME
  CorrelationId = $correlationId
} | ConvertTo-Json -Depth 3 | Set-Content -Path $metadataPath -Encoding utf8

Write-Host "[sign-windows] signing $File (correlation $correlationId)"

# /tr = RFC3161 timestamp server (Microsoft's, tied to Trusted Signing — the
#       generic timestamp servers don't accept this signing chain).
# /td  = timestamp digest algorithm
# /fd  = file digest algorithm
# /v   = verbose
& $signtool sign `
  /v `
  /fd SHA256 `
  /tr "http://timestamp.acs.microsoft.com" `
  /td SHA256 `
  /dlib $env:AZURE_TRUSTED_SIGNING_DLIB_PATH `
  /dmdf $metadataPath `
  $File

if ($LASTEXITCODE -ne 0) {
  Write-Error "[sign-windows] signtool failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}

Write-Host "[sign-windows] signed $File"
exit 0
