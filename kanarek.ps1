# Kanarek hubu na tym PC: ten sam nod (data\identity.json), proces w tle, log w data\hub.log.
# Uruchomić ponownie po restarcie PC. Zatrzymanie: Get-Process node | Where-Object { $_.CommandLine -like '*hub\src\index.js*' } | Stop-Process
$env:HUB_OWNER = '0x5Cb314D83f0b15ACa87cAeA920f242A4D19a3Dd0'
$env:HUB_DATA  = 'E:\_DF\SENSMOS\hub\data'
$env:HUB_PORT  = '80'
Start-Process -FilePath node -ArgumentList 'E:\_DF\SENSMOS\hub\src\index.js' -WorkingDirectory 'E:\_DF\SENSMOS\hub' -WindowStyle Hidden `
    -RedirectStandardOutput 'E:\_DF\SENSMOS\hub\data\hub.log' -RedirectStandardError 'E:\_DF\SENSMOS\hub\data\hub.err.log'
Start-Sleep 3
Get-Content 'E:\_DF\SENSMOS\hub\data\hub.log' -Tail 5
