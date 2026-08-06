import { InstanceBase, runEntrypoint, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import * as dgram from 'dgram'
import os from 'os'
import type { RemoteInfo } from 'dgram'

// Protocol constants
const PSN_INFO_PACKET = 0x6756
const PSN_DATA_PACKET = 0x6755
const PSN_INFO_PACKET_HEADER = 0x0000
const PSN_INFO_SYSTEM_NAME = 0x0001
const PSN_INFO_TRACKER_LIST = 0x0002
const PSN_INFO_TRACKER_NAME = 0x0000
const PSN_DATA_PACKET_HEADER = 0x0000
const PSN_DATA_TRACKER_LIST = 0x0001
const PSN_DATA_TRACKER_POS = 0x0000
const PSN_DATA_TRACKER_SPEED = 0x0001
const PSN_DATA_TRACKER_ORI = 0x0002
const PSN_DATA_TRACKER_STATUS = 0x0003
const PSN_DATA_TRACKER_ACCEL = 0x0004
const PSN_DATA_TRACKER_TRGTPOS = 0x0005
const PSN_DATA_TRACKER_TIMESTAMP = 0x0006

// Removed unused TrackerInfo interface

interface TrackerData {
	id: number
	name?: string
	pos?: { x: number; y: number; z: number }
	speed?: { x: number; y: number; z: number }
	ori?: { x: number; y: number; z: number }
	validity?: number
	accel?: { x: number; y: number; z: number }
	trgtpos?: { x: number; y: number; z: number }
	timestamp?: bigint
	lastSeen?: number
}

interface ChunkHeader {
	id: number
	dataLen: number
	hasSubchunks: boolean
}

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()
	public localIPs: { id: string; label: string }[] = []
	private socket?: dgram.Socket
	public currentTrackerList: number[] = []
	private trackers = new Map<number, TrackerData>()
	private trackerTimeoutTimers = new Map<number, NodeJS.Timeout>()
	private systemName = ''
	private packetTimestamps: number[] = []
	private connectionLostTimer?: NodeJS.Timeout
	public currentStatus: InstanceStatus = InstanceStatus.Ok

	constructor(internal: unknown) {
		super(internal)

		// Get local IPs for Config
		this.localIPs = []
		const interfaces = os.networkInterfaces()
		const interface_names = Object.keys(interfaces)
		interface_names.forEach((nic) => {
			const ips = interfaces[nic]
			if (ips) {
				ips.forEach((ip) => {
					if (ip.family == 'IPv4') {
						this.localIPs.push({ id: ip.address, label: `${nic}: ${ip.address}` })
					}
				})
			}
		})
	}

	/**
	 * Format a number rounded to a configurable number of decimal places.
	 * - Returns '' for non-finite numbers
	 * - Trims trailing zeros (e.g., 1.2 not 1.200)
	 */
	private format(value: number): string {
		if (!Number.isFinite(value)) return ''
		const decimals = typeof this.config?.decimals === 'number' && this.config.decimals >= 0 ? this.config.decimals : 3
		const factor = Math.pow(10, decimals)
		const rounded = Math.round(value * factor) / factor
		if (Object.is(rounded, -0)) return '0'
		return rounded.toFixed(decimals)
		return rounded.toFixed(decimals).replace(/\.?0+$/, '')
	}

	private isMulticastAddress(host: string): boolean {
		const parts = host.split('.')
		if (parts.length !== 4) return false
		const firstOctet = parseInt(parts[0], 10)
		return firstOctet >= 224 && firstOctet <= 239
	}

	public updateAndCheckKeyChanges(): boolean {
		const currentKeys = Array.from(this.trackers.keys())

		if (JSON.stringify(currentKeys) !== JSON.stringify(this.currentTrackerList)) {
			this.currentTrackerList = currentKeys
			return true
		}
		return false
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config

		this.updateStatus(InstanceStatus.Connecting, 'Initializing PosiStageNet connection...')

		await this.initConnection()

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updatePresets() // export Presets
		this.updateVariableDefinitions() // export variable definitions
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		await this.closeConnection()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		await this.closeConnection()
		await this.initConnection()
		// Rebuild variable definitions in case max_trackers changed
		this.updateVariableDefinitions()
		this.updatePresets()
		this.updateFeedbacks()
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this)
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	private async initConnection(): Promise<void> {
		try {
			this.log('info', `🚀 Initializing NATIVE PosiStageNet connection to ${this.config.host}:${this.config.port}`)

			this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

			this.socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
				this.handleMessage(msg, rinfo)
			})

			this.socket.on('error', (err: Error) => {
				this.log('error', `❌ UDP error: ${err.message}`)
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			})

			this.socket.on('listening', () => {
				const address = this.socket!.address()
				this.log('info', `🎧 Successfully bound to ${this.config.bind}:${address.port}`)

				// Join multicast group if the host is a multicast address
				if (this.isMulticastAddress(this.config.host)) {
					try {
						// bind fixes a problem: the operating system will choose one interface and will add membership to it (sometimes the wrong one)
						this.socket!.addMembership(this.config.host, this.config.advancedOptions ? this.config.bind : undefined)
						this.log('info', `✅ Successfully joined multicast group ${this.config.host}`)
					} catch (error) {
						this.log('error', `❌ Failed to join multicast group ${this.config.host}: ${error}`)
						this.updateStatus(InstanceStatus.ConnectionFailure, `Multicast join failed: ${error}`)
						return
					}
				} else {
					this.log('info', `📡 ${this.config.host} is not a multicast address, listening for unicast`)
				}

				this.log('info', `🔊 Listening for PosiStageNet on ${this.config.host}:${this.config.port}`)
				this.updateStatus(InstanceStatus.Ok, 'Connected to PosiStageNet (Native)')
			})

			this.socket.on('close', () => {
				this.log('info', '🔌 UDP socket closed')
			})

			this.log('info', `🔗 Binding to port ${this.config.port}...`)
			this.socket.bind(this.config.port)
		} catch (error) {
			this.log('error', `❌ Failed to create UDP socket: ${error}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, `UDP socket error: ${error}`)
		}
	}

	private async closeConnection(): Promise<void> {
		if (this.socket) {
			// Leave multicast group before closing
			if (this.isMulticastAddress(this.config.host)) {
				try {
					this.socket.dropMembership(this.config.host)
					this.log('info', `📤 Left multicast group ${this.config.host}`)
				} catch (error) {
					this.log('warn', `⚠️ Failed to leave multicast group: ${error}`)
				}
			}

			this.socket.removeAllListeners()
			this.socket.close()
			this.socket = undefined

			if (this.connectionLostTimer) {
				clearTimeout(this.connectionLostTimer)
				delete this.connectionLostTimer
			}
		}
		this.trackers.clear()

		for (const timer of this.trackerTimeoutTimers.values()) {
			clearTimeout(timer)
		}
		this.trackerTimeoutTimers.clear()
	}

	private handleMessage(buffer: Buffer, _rinfo: RemoteInfo): void {
		try {
			// Reset connection lost timer when we receive a message
			if (this.connectionLostTimer) {
				clearTimeout(this.connectionLostTimer)
				// Reset InstanceState
				if (this.currentStatus !== InstanceStatus.Ok) {
					this.updateStatus(InstanceStatus.Ok)
					this.currentStatus = InstanceStatus.Ok
				}
			}

			// Set a new timer to detect connection loss
			this.connectionLostTimer = setTimeout(() => {
				this.handleConnectionLoss()
			}, 1500) // 1.5 seconds grace period

			// Record this incoming packet for packet rate calculations
			this.recordPacket()

			const chunks = this.parseChunks(buffer, 0, buffer.length)
			for (const chunk of chunks) {
				this.processChunk(chunk, buffer)
			}
		} catch (error) {
			this.log('error', `Failed to parse message: ${error}`)
		}
	}

	private handleConnectionLoss(): void {
		this.log('warn', 'Connection appears to be lost - resetting packet rate')
		this.updateStatus(InstanceStatus.Disconnected, `Package Rate droped to 0`)
		this.currentStatus = InstanceStatus.Disconnected
		this.packetTimestamps = [] // Clear all stored timestamps
		this.updateTrackerVariables()
	}

	// Record a packet arrival and trim timestamps older than 1s
	private recordPacket(): void {
		const now = Date.now()
		this.packetTimestamps.push(now)
		const cutoff = now - 1000

		// Remove outdated entries from the front
		while (this.packetTimestamps.length > 0 && this.packetTimestamps[0] < cutoff) {
			this.packetTimestamps.shift()
		}
	}

	private parseChunks(buffer: Buffer, offset: number, length: number): Array<{ header: ChunkHeader; offset: number }> {
		const chunks: Array<{ header: ChunkHeader; offset: number }> = []
		const end = Math.min(buffer.length, offset + length)

		while (offset + 4 <= end) {
			const header = this.parseChunkHeader(buffer, offset)
			const dataStart = offset + 4
			const dataEnd = dataStart + header.dataLen
			if (dataEnd > end) {
				// Malformed or truncated chunk, stop parsing within this region
				break
			}
			chunks.push({ header, offset: dataStart })
			offset = dataEnd
		}

		return chunks
	}

	private parseChunkHeader(buffer: Buffer, offset: number): ChunkHeader {
		const headerValue = buffer.readUInt32LE(offset)
		return {
			id: headerValue & 0xffff,
			dataLen: (headerValue >> 16) & 0x7fff,
			hasSubchunks: headerValue >> 31 === 1,
		}
	}

	private processChunk(chunk: { header: ChunkHeader; offset: number }, buffer: Buffer): void {
		const { header, offset } = chunk

		switch (header.id) {
			case PSN_INFO_PACKET:
				this.processInfoPacket(buffer, offset, header.dataLen)
				break
			case PSN_DATA_PACKET:
				this.processDataPacket(buffer, offset, header.dataLen)
				break
			default:
				// Unknown chunk, ignore as per protocol spec
				break
		}
	}

	private processInfoPacket(buffer: Buffer, offset: number, length: number): void {
		const chunks = this.parseChunks(buffer, offset, length)

		for (const chunk of chunks) {
			switch (chunk.header.id) {
				case PSN_INFO_PACKET_HEADER:
					// Skip header processing for now
					break
				case PSN_INFO_SYSTEM_NAME: {
					const newSystemName = buffer.toString('utf8', chunk.offset, chunk.offset + chunk.header.dataLen)
					if (this.systemName !== newSystemName) {
						this.systemName = newSystemName
						this.log('info', `PSN System: ${this.systemName}`)
					}
					break
				}
				case PSN_INFO_TRACKER_LIST:
					this.processTrackerList(buffer, chunk.offset, chunk.header.dataLen, true)
					break
			}
		}
	}

	private processDataPacket(buffer: Buffer, offset: number, length: number): void {
		const chunks = this.parseChunks(buffer, offset, length)

		for (const chunk of chunks) {
			switch (chunk.header.id) {
				case PSN_DATA_PACKET_HEADER:
					// Skip header processing for now
					break
				case PSN_DATA_TRACKER_LIST:
					this.processTrackerList(buffer, chunk.offset, chunk.header.dataLen, false)
					break
			}
		}
	}

	private processTrackerList(buffer: Buffer, offset: number, length: number, isInfo: boolean): void {
		const chunks = this.parseChunks(buffer, offset, length)

		for (const chunk of chunks) {
			const trackerId = chunk.header.id

			if (!this.trackers.has(trackerId)) {
				this.trackers.set(trackerId, { id: trackerId })
			}

			const tracker = this.trackers.get(trackerId)!

			if (isInfo) {
				this.processTrackerInfo(tracker, buffer, chunk.offset, chunk.header.dataLen)
			} else {
				this.processTrackerData(tracker, buffer, chunk.offset, chunk.header.dataLen)
			}
		}

		this.updateTrackerVariables()
	}

	private processTrackerInfo(tracker: TrackerData, buffer: Buffer, offset: number, length: number): void {
		const chunks = this.parseChunks(buffer, offset, length)

		for (const chunk of chunks) {
			switch (chunk.header.id) {
				case PSN_INFO_TRACKER_NAME:
					tracker.name = buffer.toString('utf8', chunk.offset, chunk.offset + chunk.header.dataLen)
					break
			}
		}
	}

	private processTrackerData(tracker: TrackerData, buffer: Buffer, offset: number, length: number): void {
		const chunks = this.parseChunks(buffer, offset, length)

		for (const chunk of chunks) {
			switch (chunk.header.id) {
				case PSN_DATA_TRACKER_POS:
					if (chunk.header.dataLen >= 12) {
						tracker.pos = {
							x: buffer.readFloatLE(chunk.offset),
							y: buffer.readFloatLE(chunk.offset + 4),
							z: buffer.readFloatLE(chunk.offset + 8),
						}
					}
					break
				case PSN_DATA_TRACKER_SPEED:
					if (chunk.header.dataLen >= 12) {
						tracker.speed = {
							x: buffer.readFloatLE(chunk.offset),
							y: buffer.readFloatLE(chunk.offset + 4),
							z: buffer.readFloatLE(chunk.offset + 8),
						}
					}
					break
				case PSN_DATA_TRACKER_ORI:
					if (chunk.header.dataLen >= 12) {
						tracker.ori = {
							x: buffer.readFloatLE(chunk.offset),
							y: buffer.readFloatLE(chunk.offset + 4),
							z: buffer.readFloatLE(chunk.offset + 8),
						}
					}
					break
				case PSN_DATA_TRACKER_STATUS:
					if (chunk.header.dataLen >= 4) {
						tracker.validity = buffer.readFloatLE(chunk.offset)
					}
					break
				case PSN_DATA_TRACKER_ACCEL:
					if (chunk.header.dataLen >= 12) {
						tracker.accel = {
							x: buffer.readFloatLE(chunk.offset),
							y: buffer.readFloatLE(chunk.offset + 4),
							z: buffer.readFloatLE(chunk.offset + 8),
						}
					}
					break
				case PSN_DATA_TRACKER_TRGTPOS:
					if (chunk.header.dataLen >= 12) {
						tracker.trgtpos = {
							x: buffer.readFloatLE(chunk.offset),
							y: buffer.readFloatLE(chunk.offset + 4),
							z: buffer.readFloatLE(chunk.offset + 8),
						}
					}
					break
				case PSN_DATA_TRACKER_TIMESTAMP:
					if (chunk.header.dataLen >= 8) {
						tracker.timestamp = buffer.readBigUInt64LE(chunk.offset)
					}
					break
			}
		}

		tracker.lastSeen = Date.now()

		if (this.config.useTrackerTimeout) {
			const existing = this.trackerTimeoutTimers.get(tracker.id)
			if (existing) clearTimeout(existing)
			const deadline = this.config.trackerTimeout ?? 10
			this.trackerTimeoutTimers.set(
				tracker.id,
				setTimeout(() => {
					this.trackerTimeoutTimers.delete(tracker.id)
					this.updateTrackerVariables()
				}, deadline),
			)
		}
	}

	private updateTrackerVariables(): void {
		const variableValues: Record<string, string | number | boolean> = {}

		// Update system variables
		variableValues['system_name'] = this.systemName
		variableValues['system_tracker_count'] = this.trackers.size
		variableValues['system_tracker_ids'] = JSON.stringify(Array.from(this.trackers.keys()))
		variableValues['system_packet_rate'] = this.packetTimestamps.length

		//Compare TrackerLists and create Variables
		if (this.updateAndCheckKeyChanges()) {
			this.updateVariableDefinitions()
			this.updatePresets()
			this.updateFeedbacks()
		}

		// use Tracker IDs
		const trackersSorted = Array.from(this.trackers.values())
		for (const tracker of trackersSorted) {
			//this.log('debug', `${JSON.stringify(trackersSorted)}pos_x`)
			const prefix = `tracker_${tracker.id}_`

			if (tracker.name !== undefined) {
				variableValues[`${prefix}name`] = tracker.name
			}

			if (tracker.pos && this.config.usePos) {
				variableValues[`${prefix}pos_x`] = this.format(tracker.pos.x)
				variableValues[`${prefix}pos_y`] = this.format(tracker.pos.y)
				variableValues[`${prefix}pos_z`] = this.format(tracker.pos.z)
			}

			if (tracker.speed && this.config.useSpeed) {
				variableValues[`${prefix}speed_x`] = this.format(tracker.speed.x)
				variableValues[`${prefix}speed_y`] = this.format(tracker.speed.y)
				variableValues[`${prefix}speed_z`] = this.format(tracker.speed.z)
			}

			if (tracker.ori && this.config.useOri) {
				variableValues[`${prefix}ori_x`] = this.format(tracker.ori.x)
				variableValues[`${prefix}ori_y`] = this.format(tracker.ori.y)
				variableValues[`${prefix}ori_z`] = this.format(tracker.ori.z)
			}

			if (tracker.validity !== undefined && this.config.useValidity) {
				const timeout = this.config.trackerTimeout ?? 10
				const isStale =
					this.config.useTrackerTimeout === true &&
					(tracker.lastSeen === undefined || Date.now() - tracker.lastSeen > timeout)
				variableValues[`${prefix}validity`] = isStale ? '' : this.format(tracker.validity)
			}

			if (tracker.accel && this.config.useAccel) {
				variableValues[`${prefix}accel_x`] = this.format(tracker.accel.x)
				variableValues[`${prefix}accel_y`] = this.format(tracker.accel.y)
				variableValues[`${prefix}accel_z`] = this.format(tracker.accel.z)
			}

			if (tracker.trgtpos && this.config.useTrgtPos) {
				variableValues[`${prefix}trgtpos_x`] = this.format(tracker.trgtpos.x)
				variableValues[`${prefix}trgtpos_y`] = this.format(tracker.trgtpos.y)
				variableValues[`${prefix}trgtpos_z`] = this.format(tracker.trgtpos.z)
			}

			if (tracker.timestamp !== undefined) {
				variableValues[`${prefix}timestamp`] = Number(tracker.timestamp)
			}
		}

		this.setVariableValues(variableValues)

		this.checkFeedbacks()
	}
	//this.log('debug', `${JSON.stringify(variableValues)}`)
}

runEntrypoint(ModuleInstance, UpgradeScripts)
