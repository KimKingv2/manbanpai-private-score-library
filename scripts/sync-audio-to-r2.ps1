param(
  [Parameter(Mandatory=$true)][string]$BucketName
)
$ErrorActionPreference = 'Stop'
# Run from a folder where npx wrangler is available and `wrangler login` has completed.
# Uploads only the exact piano sample subset used by 慢半拍 and the steel-string guitar soundfont bundle.
$PianoNames = @(
'A0.mp3','C1.mp3','Ds1.mp3','Fs1.mp3','A1.mp3','C2.mp3','Ds2.mp3','Fs2.mp3','A2.mp3',
'C3.mp3','Ds3.mp3','Fs3.mp3','A3.mp3','C4.mp3','Ds4.mp3','Fs4.mp3','A4.mp3','C5.mp3',
'Ds5.mp3','Fs5.mp3','A5.mp3','C6.mp3','Ds6.mp3','Fs6.mp3','A6.mp3','C7.mp3','Ds7.mp3',
'Fs7.mp3','A7.mp3','C8.mp3'
)
$Temp = Join-Path $env:TEMP 'manbanpai-cloud-audio'
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
function Upload-Url([string]$Url,[string]$Key,[string]$ContentType) {
  $FileName = [IO.Path]::GetFileName($Key)
  $LocalPath = Join-Path $Temp $FileName
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $LocalPath
  Write-Host "Uploading $Key"
  npx wrangler r2 object put "$BucketName/$Key" --file $LocalPath --content-type $ContentType --cache-control 'private, max-age=31536000, immutable' --remote --force
  if ($LASTEXITCODE -ne 0) { throw "R2 upload failed for $Key" }
}
foreach ($Name in $PianoNames) {
  Upload-Url "https://tonejs.github.io/audio/salamander/$Name" "audio/salamander/$Name" 'audio/mpeg'
}
Upload-Url 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_guitar_steel-mp3.js' 'audio/FluidR3_GM/acoustic_guitar_steel-mp3.js' 'application/javascript; charset=utf-8'
Write-Host '慢半拍系列的播放音源已上傳至 R2。' -ForegroundColor Green
