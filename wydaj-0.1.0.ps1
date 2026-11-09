$ErrorActionPreference = 'Stop'
Set-Location E:\_DF\SENSMOS\hub

Write-Host "1/3 repo sensmos-network/sensmos-hub (publiczne) + push main" -ForegroundColor Cyan
gh repo create sensmos-network/sensmos-hub --public --source . --remote origin --push --description "Sensmos node without an ESP32: Docker image and Home Assistant add-on with the encrypted tunnel to your LAN"

Write-Host "2/3 tag v0.1.0 -> GitHub Actions buduje obraz ghcr.io/sensmos-network/sensmos-hub (amd64/arm64/armv7)" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { throw "npm test nie przeszedl - bez tagu" }
git tag v0.1.0
git push origin v0.1.0

Write-Host "3/3 pakiet GHCR musi byc publiczny: GitHub -> org sensmos-network -> Packages -> sensmos-hub -> Package settings -> Change visibility -> Public" -ForegroundColor Yellow
gh run list --repo sensmos-network/sensmos-hub --limit 1
Write-Host "gotowe; po zielonym workflow: docker compose up -d na Raspberry Pi z HUB_OWNER w .env" -ForegroundColor Green
