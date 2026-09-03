const http = require('http')
const fs = require('fs')
const path = require('path')
const express = require('express')
const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')
const { SerialPort } = require('serialport')
const { ReadlineParser } = require('@serialport/parser-readline')

require('dotenv').config()

/**
 * Raspberry Pi API
 * - REST: /api/*
 * - Soundboard: /api/sound/*
 * - Live talk (raw PCM over WS): /ws/talk
 * - Serial console (JSON over WS): /ws/console
 * - Sensor telemetry: /api/sensors
 */

const app = express()
const publicDir = path.join(__dirname, 'public')
const soundsDir = '/var/www/sounds'
const hintsDir = path.join(soundsDir, 'hints')
const hintCatalogFile = path.join(hintsDir, 'catalog.json')

app.use(express.json({ limit: '25mb' }))
app.use(express.static(publicDir))

// ====================== CONFIG ======================
const PORT = process.env.PORT || 8001
const SERIAL_CONFIG_FILE = process.env.SERIAL_CONFIG_FILE || path.join(__dirname, '.serial-port')
let SERIAL_PORT = readSerialPath() || process.env.SERIAL_PORT || '/dev/ttyUSB0'
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || 9600)

function validSerialPath(value) {
	return typeof value === 'string' && value.startsWith('/dev/') && !value.includes('..') && /^\/dev\/[A-Za-z0-9._/-]+$/.test(value) && value.length <= 255
}

function readSerialPath() {
	try {
		const value = fs.readFileSync(SERIAL_CONFIG_FILE, 'utf8').trim()
		return validSerialPath(value) ? value : null
	} catch {
		return null
	}
}

// ====================== SERIAL ======================
let serial = {
	enabled: false,
	port: null,
	lastLine: null,
	lines: [],
}

let sensors = {
	updatedAt: null,
	values: null,
}

let serialReadyAt = 0
let serialGeneration = 0

function nowIso() {
	return new Date().toISOString()
}

function serialEntry(direction, line) {
	return { at: nowIso(), direction, line }
}

function rememberSerialEntry(entry) {
	serial.lines.push(entry)
	if (serial.lines.length > 500) serial.lines.shift()
}

function cleanSerialCommand(value) {
	return String(value || '')
		.replace(/[\r\n]+/g, ' ')
		.trim()
		.slice(0, 127)
}

function writeSerialCommand(command) {
	const line = cleanSerialCommand(command)
	if (!line) return { ok: false, error: 'Command is empty' }
	if (!serial.enabled || !serial.port?.writable) {
		return { ok: false, error: 'Serial port is offline' }
	}

	serial.port.write(line + '\n')
	const entry = serialEntry('out', line)
	rememberSerialEntry(entry)
	broadcastConsole({ type: 'line', entry })
	console.log('SERIAL <', line)
	return { ok: true, line }
}

const SENSOR_KEYS = [
	'table0',
	'table1',
	'table2',
	'table3',
	'table4',
	'tableTop',
	'tableBottom',
	'mortar',
	'plate1Move',
	'plate1Home',
	'plate2Move',
	'plate2Home',
	'plate3Move',
	'plate3Home',
	'plate4Move',
	'plate4Home',
	'rope',
	'ir',
	'mask',
	'bearItem',
	'bearHead',
	'puzzle15',
	'spareTable',
	'start',
	'game',
]

function parseSensorLine(line) {
	if (line.startsWith('BSENSORS ')) line = line.slice(1)
	if (!line.startsWith('SENSORS ')) return false

	const values = {}
	const rawValues = line.slice(8).trim().split(',')
	for (let index = 0; index < SENSOR_KEYS.length; index++) {
		const value = Number(rawValues[index])
		if (Number.isFinite(value)) values[SENSOR_KEYS[index]] = value
	}

	sensors = {
		updatedAt: nowIso(),
		values,
	}
	return true
}

function requestSensorSnapshot() {
	if (!serial.enabled || !serial.port?.writable) return
	if (Date.now() < serialReadyAt) return
	serial.port.write('ADMIN SENSORS\n')
}

function connectSerial(serialPath = SERIAL_PORT) {
	if (!validSerialPath(serialPath)) throw new Error('Invalid serial path')
	const generation = ++serialGeneration
	const previous = serial.port
	serial.enabled = false
	serial.port = null
	serialReadyAt = 0
	if (previous?.isOpen) previous.close(error => error && console.error('Serial close error:', error.message))

	try {
	const port = new SerialPort({
		path: serialPath,
		baudRate: SERIAL_BAUD,
		autoOpen: true,
	})

	const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))

	parser.on('data', line => {
		if (generation !== serialGeneration) return
		const clean = String(line).replace(/\r/g, '')
		if (parseSensorLine(clean)) return
		serial.lastLine = clean
		const entry = serialEntry('in', clean)
		rememberSerialEntry(entry)
		broadcastConsole({ type: 'line', entry })
		console.log('SERIAL >', clean)
	})

	port.on('open', () => {
		if (generation !== serialGeneration) return port.close()
		serial.enabled = true
		serial.port = port
		serialReadyAt = Date.now() + 4000
		broadcastConsoleStatus()
		console.log('Serial connected:', serialPath)
	})

	port.on('close', () => {
		if (generation !== serialGeneration) return
		serial.enabled = false
		serial.port = null
		serialReadyAt = 0
		sensors = { updatedAt: null, values: null }
		broadcastConsoleStatus()
		console.log('Serial disconnected:', serialPath)
	})

	port.on('error', err => {
		if (generation !== serialGeneration) return
		serial.enabled = false
		broadcastConsoleStatus()
		console.error('Serial error:', err.message)
	})
	} catch (e) {
	console.error('Serial init failed:', e.message)
	}
}

connectSerial()

// =================== ADMIN COMMANDS =================
const ADMIN_COMMANDS = new Set([
	'ADMIN STATUS',
	'ADMIN START',
	'ADMIN RESET',
	'ADMIN ESTOP',

	'ADMIN LIGHT UV',
	'ADMIN LIGHT RESET',
	'ADMIN LIGHT WHITE',
	'ADMIN LIGHT OK',
	'ADMIN LIGHT OFF',

	'ADMIN OVEN RESET',
	'ADMIN OVEN SOLVED',

	'ADMIN OVEN UV ON',
	'ADMIN OVEN UV OFF',
	'ADMIN OVEN LIGHT ON',
	'ADMIN OVEN LIGHT OFF',
	'ADMIN OVEN MOVE ON',
	'ADMIN OVEN MOVE OFF',
	'ADMIN OVEN FOG ON',
	'ADMIN OVEN FOG OFF',

	'ADMIN PUZZLE SOLVE',
	'ADMIN PUZZLE RESET',

	'ADMIN BEAR SOUND',
	'ADMIN BEAR OPEN',
	'ADMIN BEAR CLOSE',

	'ADMIN MASK SOUND',

	'ADMIN DOOR OPEN',
	'ADMIN DOOR CLOSE',

	'ADMIN TABLE OPEN',
	'ADMIN TABLE CLOSE',
	'ADMIN TABLE LEG OPEN',
	'ADMIN TABLE LEG CLOSE',
])

function normalize(cmd) {
	return String(cmd || '')
		.replace(/\r/g, '')
		.trim()
		.replace(/\s+/g, ' ')
}

function validate(cmd) {
	const c = normalize(cmd)
	if (!c.startsWith('ADMIN '))
		return { ok: false, error: 'Command must start with ADMIN' }
	if (!ADMIN_COMMANDS.has(c))
		return { ok: false, error: 'Unknown ADMIN command' }
	return { ok: true, cmd: c }
}

function safeSegment(value) {
	return String(value || '')
		.toUpperCase()
		.replace(/[^A-Z0-9_-]/g, '')
}

function hintPath(puzzle, slot) {
	const safePuzzle = safeSegment(puzzle)
	const safeSlot = String(Number(slot || 0))
	if (!safePuzzle || !safeSlot || safeSlot === '0') return null
	return path.join(hintsDir, safePuzzle, `${safeSlot}.mp3`)
}

function relativeSoundPath(file) {
	return path.relative(soundsDir, file).replace(/\\/g, '/')
}

const DEFAULT_HINT_CATALOG = [
	{
		id: '15PUZZLE',
		label: '15PUZZLE',
		hints: [{ slot: 1, label: 'Подсказка 1' }],
	},
]

function readHintCatalog() {
	try {
		if (fs.existsSync(hintCatalogFile)) {
			const parsed = JSON.parse(fs.readFileSync(hintCatalogFile, 'utf8'))
			if (Array.isArray(parsed)) return parsed
		}
	} catch (e) {
		console.error('Hint catalog read failed:', e.message)
	}
	return DEFAULT_HINT_CATALOG
}

function writeHintCatalog(catalog) {
	fs.mkdirSync(hintsDir, { recursive: true })
	fs.writeFileSync(hintCatalogFile, JSON.stringify(catalog, null, 2))
}

function normalizeHintCatalog(catalog) {
	return catalog
		.map(puzzle => ({
			id: safeSegment(puzzle.id || puzzle.label),
			label: String(puzzle.label || puzzle.id || '').trim(),
			hints: Array.isArray(puzzle.hints) ? puzzle.hints : [],
		}))
		.filter(puzzle => puzzle.id && puzzle.label)
		.map(puzzle => ({
			...puzzle,
			hints: puzzle.hints
				.map(hint => ({
					slot: Number(hint.slot),
					label: String(hint.label || `Подсказка ${hint.slot}`).trim(),
				}))
				.filter(hint => hint.slot > 0 && hint.label),
		}))
}

function catalogWithFiles() {
	return normalizeHintCatalog(readHintCatalog()).map(puzzle => ({
		...puzzle,
		hints: puzzle.hints.map(hint => {
			const file = hintPath(puzzle.id, hint.slot)
			const stat = file && fs.existsSync(file) ? fs.statSync(file) : null
			return {
				...hint,
				exists: Boolean(stat),
				size: stat?.size || 0,
				updatedAt: stat?.mtime?.toISOString() || null,
				sound: stat ? relativeSoundPath(file) : null,
			}
		}),
	}))
}

// ======================= STATE ======================
const state = {
	lastCommand: null,
	lastAt: null,
	lastResult: null,
}

const controlState = { door: false, table: false, tableLeg: false, ovenUv: false, ovenMove: false }
const SENSOR_EXPECTED = {
	table0: 1, table1: 0, table2: 1, table3: 1, table4: 1, tableTop: 0, tableBottom: 1,
	mortar: 1, plate1Move: 0, plate1Home: 0, plate2Move: 0, plate2Home: 0,
	plate3Move: 0, plate3Home: 0, plate4Move: 0, plate4Home: 0, rope: 0, ir: 0,
	mask: 0, bearItem: 0, start: 0, game: 0,
}
const ROOM_CONFIG = {
	version: 1,
	title: 'Krampus House',
	state: { pollMs: 2000 },
	blocks: [
		{ id: 'game', title: 'Игра', width: 'full', categories: [{ id: 'session', title: 'Управление', controls: [
			{ id: 'start', type: 'button', label: 'START', command: 'ADMIN START' },
			{ id: 'status', type: 'button', label: 'STATUS', command: 'ADMIN STATUS' },
			{ id: 'reset', type: 'button', label: 'RESET', command: 'ADMIN RESET' },
			{ id: 'estop', type: 'button', label: 'ESTOP', command: 'ADMIN ESTOP' },
		] }] },
		{ id: 'light', title: 'Свет и атмосфера', width: 'half', categories: [
			{ id: 'light-mode', title: 'Режим света', controls: [
				{ id: 'light-uv', type: 'button', label: 'UV', command: 'ADMIN LIGHT UV' },
				{ id: 'light-white', type: 'button', label: 'Белый', command: 'ADMIN LIGHT WHITE' },
				{ id: 'light-game', type: 'button', label: 'Игровой', command: 'ADMIN LIGHT OK' },
				{ id: 'light-off', type: 'button', label: 'Выключить', command: 'ADMIN LIGHT OFF' },
			] },
			{ id: 'atmosphere', title: 'Разовые действия', controls: [
				{ id: 'mask-sound', type: 'button', label: 'Звук маски', command: 'ADMIN MASK SOUND' },
				{ id: 'light-reset', type: 'button', label: 'Сброс света', command: 'ADMIN LIGHT RESET' },
			] },
		] },
		{ id: 'mechanisms', title: 'Механизмы', width: 'half', categories: [
			{ id: 'main-mechanisms', title: 'Основные', controls: [
				{ id: 'door', type: 'checkbox', label: 'Дверь', statePath: 'controls.door', onLabel: 'Открыта', offLabel: 'Закрыта', onCommand: 'ADMIN DOOR OPEN', offCommand: 'ADMIN DOOR CLOSE' },
				{ id: 'table', type: 'checkbox', label: 'Стол', statePath: 'controls.table', onLabel: 'Открыт', offLabel: 'Закрыт', onCommand: 'ADMIN TABLE OPEN', offCommand: 'ADMIN TABLE CLOSE' },
				{ id: 'table-leg', type: 'checkbox', label: 'Ножка стола', statePath: 'controls.tableLeg', onLabel: 'Открыта', offLabel: 'Закрыта', onCommand: 'ADMIN TABLE LEG OPEN', offCommand: 'ADMIN TABLE LEG CLOSE' },
			] },
			{ id: 'bear', title: 'Медведь', controls: [
				{ id: 'bear-open', type: 'button', label: 'Открыть', command: 'ADMIN BEAR OPEN' },
				{ id: 'bear-close', type: 'button', label: 'Закрыть', command: 'ADMIN BEAR CLOSE' },
				{ id: 'bear-sound', type: 'button', label: 'Включить звук', command: 'ADMIN BEAR SOUND' },
			] },
			{ id: 'puzzle', title: 'Пятнашки', controls: [
				{ id: 'puzzle-solve', type: 'button', label: 'Решить', command: 'ADMIN PUZZLE SOLVE' },
				{ id: 'puzzle-reset', type: 'button', label: 'Сбросить', command: 'ADMIN PUZZLE RESET' },
			] },
		] },
		{ id: 'oven', title: 'Печка', width: 'half', categories: [{ id: 'oven-controls', title: 'Управление', controls: [
			{ id: 'oven-uv', type: 'checkbox', label: 'Печка решена', statePath: 'controls.ovenUv', onLabel: 'Решена', offLabel: 'Не решена', onCommand: 'ADMIN OVEN UV ON', offCommand: 'ADMIN OVEN UV OFF' },
			{ id: 'oven-move', type: 'checkbox', label: 'Движение печки', statePath: 'controls.ovenMove', onCommand: 'ADMIN OVEN MOVE ON', offCommand: 'ADMIN OVEN MOVE OFF' },
		] }] },
		{ id: 'sensors', title: 'Датчики', width: 'full', categories: [{ id: 'sensor-state', title: 'Текущее состояние', controls: Object.keys(SENSOR_EXPECTED).map(key => ({ id: `sensor-${key}`, type: 'indicator', label: key, statePath: `sensors.${key}`, expectedValue: SENSOR_EXPECTED[key], onLabel: 'Норма', offLabel: 'Не сработал' })) }] },
	],
}

function rememberControlState(command) {
	const changes = {
		'ADMIN DOOR OPEN': ['door', true], 'ADMIN DOOR CLOSE': ['door', false],
		'ADMIN TABLE OPEN': ['table', true], 'ADMIN TABLE CLOSE': ['table', false],
		'ADMIN TABLE LEG OPEN': ['tableLeg', true], 'ADMIN TABLE LEG CLOSE': ['tableLeg', false],
		'ADMIN OVEN UV ON': ['ovenUv', true], 'ADMIN OVEN UV OFF': ['ovenUv', false],
		'ADMIN OVEN MOVE ON': ['ovenMove', true], 'ADMIN OVEN MOVE OFF': ['ovenMove', false],
	}
	const change = changes[command]
	if (change) controlState[change[0]] = change[1]
}

// ======================== API =======================
app.get('/api/status', (req, res) => {
	res.json({
		ok: true,
		serial: {
			enabled: serial.enabled,
			port: SERIAL_PORT,
			lastLine: serial.lastLine,
		},
		state,
	})
})

app.get('/api/room-config', (req, res) => res.json(ROOM_CONFIG))

app.get('/api/room-status', (req, res) => {
	const ageMs = sensors.updatedAt ? Date.now() - Date.parse(sensors.updatedAt) : null
	res.json({
		online: serial.enabled,
		updatedAt: sensors.updatedAt,
		stale: ageMs === null || ageMs > 3000,
		controls: controlState,
		sensors: sensors.values || {},
	})
})

app.get('/api/serial/tail', (req, res) => {
	res.json({ ok: true, lines: serial.lines.slice(-500) })
})

app.post('/api/serial/config', (req, res) => {
	const serialPath = String(req.body?.path || '').trim()
	if (!validSerialPath(serialPath)) return res.status(400).json({ ok: false, error: 'INVALID_SERIAL_PATH' })
	try {
		fs.writeFileSync(SERIAL_CONFIG_FILE, `${serialPath}\n`, { mode: 0o600 })
		SERIAL_PORT = serialPath
		connectSerial(serialPath)
		res.json({ ok: true, path: serialPath })
	} catch (error) {
		console.error('Serial configuration failed:', error.message)
		res.status(500).json({ ok: false, error: 'SERIAL_CONFIGURATION_FAILED' })
	}
})

app.get('/api/sensors', (req, res) => {
	const ageMs = sensors.updatedAt ? Date.now() - Date.parse(sensors.updatedAt) : null
	res.json({
		ok: true,
		serial: serialStatus(),
		updatedAt: sensors.updatedAt,
		ageMs,
		stale: ageMs === null || ageMs > 3000,
		values: sensors.values,
	})
})

app.post('/api/admin', (req, res) => {
	const { cmd } = req.body || {}
	const v = validate(cmd)
	if (!v.ok) return res.status(400).json({ ok: false, error: v.error })

	state.lastCommand = v.cmd
	state.lastAt = nowIso()
	rememberControlState(v.cmd)

	let result = { mode: 'mock', wrote: v.cmd }

	try {
		if (serial.enabled && serial.port) {
			const writeResult = writeSerialCommand(v.cmd)
			result = writeResult.ok
				? { mode: 'serial', wrote: v.cmd }
				: { mode: 'serial', wrote: v.cmd, error: writeResult.error }
		}
	} catch (e) {
		result = { mode: 'serial', wrote: v.cmd, error: e.message }
	}

	state.lastResult = result
	console.log('ADMIN >', v.cmd)
	res.json({ ok: true, state, result })
})


// =================== SOUND: BOARDBOX =================
let playerProc = null

function stopPlayer() {
	if (playerProc) {
		try {
			playerProc.kill('SIGKILL')
		} catch {}
		playerProc = null
	}
}

function playFile(path) {
	stopPlayer()
	// mpg123 for mp3 (use aplay for wav)
	playerProc = spawn('mpg123', ['-q', path], { stdio: 'ignore' })
	playerProc.on('exit', () => (playerProc = null))
}

app.post('/api/sound/play', (req, res) => {
	const { sound } = req.body || {}
	const file = path.resolve(soundsDir, sound || '')
	if (!file.startsWith(soundsDir) || !fs.existsSync(file)) {
		return res.status(400).json({ ok: false, error: 'unknown sound' })
	}
	playFile(file)
	res.json({ ok: true })
})

app.post('/api/sound/stop', (req, res) => {
	stopPlayer()
	res.json({ ok: true })
})

app.get('/api/hints', (req, res) => {
	res.json({ ok: true, catalog: catalogWithFiles() })
})

app.post('/api/hints/puzzles', (req, res) => {
	const label = String(req.body?.label || '').trim()
	if (!label) return res.status(400).json({ ok: false, error: 'label is required' })

	const catalog = normalizeHintCatalog(readHintCatalog())
	const idBase = safeSegment(label)
	if (!idBase) return res.status(400).json({ ok: false, error: 'bad label' })

	let id = idBase
	let suffix = 2
	while (catalog.some(puzzle => puzzle.id === id)) {
		id = `${idBase}_${suffix}`
		suffix++
	}

	catalog.push({ id, label, hints: [] })
	writeHintCatalog(catalog)
	res.json({ ok: true, catalog: catalogWithFiles() })
})

app.post('/api/hints/puzzles/:puzzle/hints', (req, res) => {
	const puzzleId = safeSegment(req.params.puzzle)
	const catalog = normalizeHintCatalog(readHintCatalog())
	const puzzle = catalog.find(item => item.id === puzzleId)
	if (!puzzle) return res.status(404).json({ ok: false, error: 'puzzle not found' })

	const nextSlot = puzzle.hints.reduce((max, hint) => Math.max(max, hint.slot), 0) + 1
	const label = String(req.body?.label || `Подсказка ${nextSlot}`).trim()
	puzzle.hints.push({ slot: nextSlot, label })

	writeHintCatalog(catalog)
	res.json({ ok: true, catalog: catalogWithFiles() })
})

app.delete('/api/hints/puzzles/:puzzle', (req, res) => {
	const puzzleId = safeSegment(req.params.puzzle)
	const catalog = normalizeHintCatalog(readHintCatalog())
	const nextCatalog = catalog.filter(item => item.id !== puzzleId)
	if (nextCatalog.length === catalog.length) {
		return res.status(404).json({ ok: false, error: 'puzzle not found' })
	}

	const dir = path.join(hintsDir, puzzleId)
	if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
	writeHintCatalog(nextCatalog)
	res.json({ ok: true, catalog: catalogWithFiles() })
})

app.delete('/api/hints/puzzles/:puzzle/hints/:slot', (req, res) => {
	const puzzleId = safeSegment(req.params.puzzle)
	const slot = Number(req.params.slot)
	const catalog = normalizeHintCatalog(readHintCatalog())
	const puzzle = catalog.find(item => item.id === puzzleId)
	if (!puzzle) return res.status(404).json({ ok: false, error: 'puzzle not found' })

	const nextHints = puzzle.hints.filter(hint => hint.slot !== slot)
	if (nextHints.length === puzzle.hints.length) {
		return res.status(404).json({ ok: false, error: 'hint not found' })
	}
	puzzle.hints = nextHints

	const file = hintPath(puzzleId, slot)
	if (file && fs.existsSync(file)) fs.rmSync(file, { force: true })
	writeHintCatalog(catalog)
	res.json({ ok: true, catalog: catalogWithFiles() })
})

app.post('/api/hints/upload', (req, res) => {
	const { puzzle, slot, filename, data } = req.body || {}
	const file = hintPath(puzzle, slot)
	if (!file) return res.status(400).json({ ok: false, error: 'bad hint target' })
	if (!String(filename || '').toLowerCase().endsWith('.mp3')) {
		return res.status(400).json({ ok: false, error: 'only mp3 files are allowed' })
	}

	const match = String(data || '').match(/^data:audio\/(?:mpeg|mp3);base64,(.+)$/)
	if (!match) return res.status(400).json({ ok: false, error: 'bad mp3 payload' })

	const buffer = Buffer.from(match[1], 'base64')
	const hasMp3Header = buffer.slice(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
	if (!hasMp3Header) return res.status(400).json({ ok: false, error: 'file does not look like mp3' })

	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, buffer)
	res.json({ ok: true, sound: relativeSoundPath(file), size: buffer.length })
})

app.post('/api/hints/play', (req, res) => {
	const { puzzle, slot } = req.body || {}
	const file = hintPath(puzzle, slot)
	if (!file || !fs.existsSync(file)) {
		return res.status(404).json({ ok: false, error: 'hint mp3 not found' })
	}
	playFile(file)
	res.json({ ok: true, sound: relativeSoundPath(file) })
})

app.get(/^(?!\/api|\/ws).*/, (req, res) => {
	res.sendFile(path.join(publicDir, 'index.html'))
})

// ====================== HTTP SERVER ==================
const server = http.createServer(app)

const sensorPollTimer = setInterval(requestSensorSnapshot, 750)
sensorPollTimer.unref()

// ===================== WS: LIVE TALK =================
// Формат: raw PCM s16le mono 16000 Hz (очень стабильный для речи)
const TALK_SR = 16000
const aplayArgs = [
	'-f',
	'S16_LE',
	'-c',
	'1',
	'-r',
	String(TALK_SR),
	'-t',
	'raw',
	'-',
]

const talkWss = new WebSocketServer({ noServer: true })
const consoleWss = new WebSocketServer({ noServer: true })

function serialStatus() {
	return {
		enabled: serial.enabled,
		port: SERIAL_PORT,
		baudRate: SERIAL_BAUD,
	}
}

function sendWsJson(ws, payload) {
	if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

function broadcastConsole(payload) {
	for (const client of consoleWss.clients) {
		sendWsJson(client, payload)
	}
}

function broadcastConsoleStatus() {
	broadcastConsole({ type: 'status', serial: serialStatus() })
}

server.on('upgrade', (request, socket, head) => {
	let pathname
	try {
		pathname = new URL(request.url, 'http://localhost').pathname
	} catch {
		socket.destroy()
		return
	}

	const target = pathname === '/ws/talk'
		? talkWss
		: pathname === '/ws/console'
			? consoleWss
			: null

	if (!target) {
		socket.destroy()
		return
	}

	target.handleUpgrade(request, socket, head, ws => {
		target.emit('connection', ws, request)
	})
})

// Один live-канал (чтобы не мешали друг другу).
let liveOwner = null

talkWss.on('connection', ws => {
	if (liveOwner && liveOwner.readyState === 1) {
		ws.close(1013, 'Live channel busy')
		return
	}
	liveOwner = ws

	// когда начинается live — лучше остановить проигрывание файлов, чтобы не смешивалось
	stopPlayer()

	const aplay = spawn('aplay', aplayArgs, {
		stdio: ['pipe', 'ignore', 'ignore'],
	})

	aplay.on('exit', () => {
		if (liveOwner === ws) liveOwner = null
	})

	ws.on('message', data => {
		// ожидаем бинарные данные (Buffer) — raw PCM
		if (Buffer.isBuffer(data)) {
			// если aplay умер — игнор
			if (aplay.stdin.writable) aplay.stdin.write(data)
		}
	})

	ws.on('close', () => {
		try {
			aplay.stdin.end()
		} catch {}
		try {
			aplay.kill('SIGKILL')
		} catch {}
		if (liveOwner === ws) liveOwner = null
	})
})

// =================== WS: SERIAL CONSOLE =============
consoleWss.on('connection', ws => {
	sendWsJson(ws, {
		type: 'snapshot',
		serial: serialStatus(),
		lines: serial.lines.slice(-500),
	})

	ws.on('message', data => {
		let message
		try {
			message = JSON.parse(data.toString())
		} catch {
			sendWsJson(ws, { type: 'error', error: 'Invalid JSON message' })
			return
		}

		if (message?.type !== 'command') {
			sendWsJson(ws, { type: 'error', error: 'Unknown message type' })
			return
		}

		try {
			const result = writeSerialCommand(message.command)
			if (!result.ok) {
				sendWsJson(ws, { type: 'error', error: result.error })
			}
		} catch (e) {
			sendWsJson(ws, { type: 'error', error: e.message })
		}
	})
})

// ======================= START =======================
server.listen(PORT, '0.0.0.0', () => {
	console.log(`API running: http://localhost:${PORT}/api`)
	console.log(`WS live talk: ws://localhost:${PORT}/ws/talk`)
	console.log(`WS serial console: ws://localhost:${PORT}/ws/console`)
	console.log(`Serial: ${SERIAL_PORT} @ ${SERIAL_BAUD}`)
})
