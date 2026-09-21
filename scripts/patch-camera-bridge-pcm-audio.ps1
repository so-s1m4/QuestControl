param(
  [string]$BridgeRoot = "C:\Users\Escapers\Documents\CameraBridge-Windows"
)

$ErrorActionPreference = "Stop"
$rtspRoot = Join-Path $BridgeRoot "vendor\tuya-ipc-terminal\pkg\rtsp"
$bridgeFile = Join-Path $rtspRoot "bridge.go"
$forwarderFile = Join-Path $rtspRoot "forwarder.go"

foreach ($file in @($bridgeFile, $forwarderFile)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Bridge source not found: $file" }
  Copy-Item -LiteralPath $file -Destination "$file.bak" -Force
}

function Replace-Required([string]$Text, [string]$Old, [string]$New, [string]$Description) {
  if (-not $Text.Contains($Old)) { throw "Expected source fragment not found: $Description" }
  return $Text.Replace($Old, $New)
}

$nl = [Environment]::NewLine

$bridge = [IO.File]::ReadAllText($bridgeFile)
if (-not $bridge.Contains("func cameraAudioIsLittleEndian(")) {
  $bridge = Replace-Required $bridge "rtpForwarder:   NewRTPForwarder()," "rtpForwarder:   NewRTPForwarder(cameraAudioIsLittleEndian(camera))," "WebRTC bridge constructor"
  $helper = @"
func cameraAudioIsLittleEndian(camera *storage.CameraInfo) bool {
	var skill tuya.Skill
	if camera == nil || json.Unmarshal([]byte(camera.Skill), &skill) != nil {
		return false
	}
	for _, audio := range skill.Audios {
		if audio.CodecType == 101 && audio.DataBit == 16 {
			return true
		}
	}
	return false
}

"@
  $bridge = Replace-Required $bridge "func (wb *WebRTCBridge) Start() error {" ($helper + "func (wb *WebRTCBridge) Start() error {") "WebRTC bridge start method"
  [IO.File]::WriteAllText($bridgeFile, $bridge, (New-Object Text.UTF8Encoding($false)))
}

$forwarder = [IO.File]::ReadAllText($forwarderFile)
if (-not $forwarder.Contains("audioLittleEndian bool")) {
  $forwarder = Replace-Required $forwarder "firstAudioPacket bool" ("firstAudioPacket bool" + $nl + "	audioLittleEndian bool") "RTP forwarder state"
  $forwarder = Replace-Required $forwarder "func NewRTPForwarder() *RTPForwarder {" "func NewRTPForwarder(audioLittleEndian bool) *RTPForwarder {" "RTP forwarder constructor"
  $forwarder = Replace-Required $forwarder ("firstAudioPacket: true," + $nl + "	}") ("firstAudioPacket: true," + $nl + "		audioLittleEndian: audioLittleEndian," + $nl + "	}") "RTP forwarder configuration"
  $swap = @"
	// Tuya codecType 101 is signed 16-bit little-endian PCM (PCML), while
	// RTSP L16 is big-endian. Swap a copied payload before sending it.
	if rf.audioLittleEndian && len(packet.Payload) > 1 {
		payload := append([]byte(nil), packet.Payload...)
		for i := 0; i+1 < len(payload); i += 2 {
			payload[i], payload[i+1] = payload[i+1], payload[i]
		}
		header := packet.Header
		packet = &rtp.Packet{Header: header, Payload: payload}
	}

"@
  $forwarder = Replace-Required $forwarder "	// Serialize packet" ($swap + "	// Serialize packet") "audio RTP serialization"
  [IO.File]::WriteAllText($forwarderFile, $forwarder, (New-Object Text.UTF8Encoding($false)))
}

Push-Location $BridgeRoot
try {
  docker compose -f docker-compose.ports.yml up -d --build
  Start-Sleep -Seconds 12
  docker ps --filter "name=tuya-rtsp-bridge" --format "table {{.Names}}\t{{.Status}}"
  docker logs --tail 30 tuya-rtsp-bridge
} finally {
  Pop-Location
}
