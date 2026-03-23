import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage, LfgMission, Message, PlayerProfile } from "../shared";

// ---------------------------------------------------------------------------
// Extend Env with KV + D1 bindings (wrangler types will regenerate this)
// ---------------------------------------------------------------------------
interface AppEnv extends Env {
	LFG_BOARD: KVNamespace;
	PLAYER_DB: D1Database;
}

// ---------------------------------------------------------------------------
// Chat Durable Object — Chat ONLY (no more LFG)
// ---------------------------------------------------------------------------
export class Chat extends Server<AppEnv> {
	static options = { hibernate: true };

	messages = [] as ChatMessage[];

	broadcastMessage(message: Message, exclude?: string[]) {
		this.broadcast(JSON.stringify(message), exclude);
	}

	onStart() {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
		);

		this.messages = this.ctx.storage.sql
			.exec(`SELECT * FROM messages`)
			.toArray() as ChatMessage[];
	}

	onConnect(connection: Connection) {
		connection.send(
			JSON.stringify({
				type: "all",
				messages: this.messages,
			} satisfies Message),
		);
	}

	saveMessage(message: ChatMessage) {
		const existingMessage = this.messages.find((m) => m.id === message.id);
		if (existingMessage) {
			this.messages = this.messages.map((m) => {
				if (m.id === message.id) {
					return message;
				}
				return m;
			});
		} else {
			this.messages.push(message);
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO messages (id, user, role, content) VALUES (?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET content = ?`,
			message.id,
			message.user,
			message.role,
			message.content,
			message.content,
		);
	}

	onMessage(connection: Connection, message: WSMessage) {
		this.broadcast(message);

		const parsed = JSON.parse(message as string) as Message;
		if (parsed.type === "add" || parsed.type === "update") {
			this.saveMessage(parsed);
		}
	}
}

// ---------------------------------------------------------------------------
// CORS helper
// ---------------------------------------------------------------------------
const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", ...corsHeaders },
	});
}

// ---------------------------------------------------------------------------
// REST API Router
// ---------------------------------------------------------------------------
async function handleApiRequest(request: Request, env: AppEnv): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;

	// CORS preflight
	if (request.method === "OPTIONS") {
		return new Response(null, { headers: corsHeaders });
	}

	// -----------------------------------------------------------------------
	// GET /api/lfg — List all active missions
	// -----------------------------------------------------------------------
	if (path === "/api/lfg" && request.method === "GET") {
		const list = await env.LFG_BOARD.list({ prefix: "lfg:" });
		const missions: LfgMission[] = [];

		for (const key of list.keys) {
			const val = await env.LFG_BOARD.get(key.name, "json");
			if (val) missions.push(val as LfgMission);
		}

		return json({ missions });
	}

	// -----------------------------------------------------------------------
	// POST /api/lfg — Post a new mission
	// -----------------------------------------------------------------------
	if (path === "/api/lfg" && request.method === "POST") {
		const body = await request.json() as { room: string; username: string; konamiId: string };

		if (!body.room || !body.username) {
			return json({ error: "room and username required" }, 400);
		}

		const mission: LfgMission = {
			room: body.room,
			username: body.username,
			konamiId: body.konamiId || "",
			postedAt: Date.now(),
		};

		// Store with 10-min TTL — auto-expiry, no cleanup needed
		await env.LFG_BOARD.put(`lfg:${body.room}`, JSON.stringify(mission), {
			expirationTtl: 600,
		});

		return json({ ok: true, mission });
	}

	// -----------------------------------------------------------------------
	// POST /api/lfg/:room/join — Join a mission
	// -----------------------------------------------------------------------
	const joinMatch = path.match(/^\/api\/lfg\/([^/]+)\/join$/);
	if (joinMatch && request.method === "POST") {
		const room = decodeURIComponent(joinMatch[1]);
		const body = await request.json() as { joinerUsername: string };

		// Get the mission to find the commander
		const mission = await env.LFG_BOARD.get(`lfg:${room}`, "json") as LfgMission | null;
		if (!mission) {
			return json({ error: "Mission not found or expired" }, 404);
		}

		// Delete the mission (first come first served)
		await env.LFG_BOARD.delete(`lfg:${room}`);

		// Set an alert for the commander (2-min TTL)
		await env.LFG_BOARD.put(
			`alert:${mission.username}`,
			JSON.stringify({
				type: "match_joined",
				message: "MATCH REQUEST INTERCEPTED: CHECK YOUR RECEIPTS FOR INCOMING FRIEND REQUESTS.",
				joiner: body.joinerUsername || "UNKNOWN",
				room,
				timestamp: Date.now(),
			}),
			{ expirationTtl: 120 },
		);

		return json({
			ok: true,
			commander: mission.username,
			konamiId: mission.konamiId,
		});
	}

	// -----------------------------------------------------------------------
	// POST /api/lfg/:room/close — Close own mission
	// -----------------------------------------------------------------------
	const closeMatch = path.match(/^\/api\/lfg\/([^/]+)\/close$/);
	if (closeMatch && request.method === "POST") {
		const room = decodeURIComponent(closeMatch[1]);
		await env.LFG_BOARD.delete(`lfg:${room}`);
		return json({ ok: true });
	}

	// -----------------------------------------------------------------------
	// GET /api/lfg/alerts/:username — Poll for pending alerts
	// -----------------------------------------------------------------------
	const alertMatch = path.match(/^\/api\/lfg\/alerts\/([^/]+)$/);
	if (alertMatch && request.method === "GET") {
		const username = decodeURIComponent(alertMatch[1]);
		const alert = await env.LFG_BOARD.get(`alert:${username}`, "json");

		if (alert) {
			// Consume the alert (one-time read)
			await env.LFG_BOARD.delete(`alert:${username}`);
			return json({ alert });
		}

		return json({ alert: null });
	}

	// -----------------------------------------------------------------------
	// POST /api/profile — Register or update a profile
	// -----------------------------------------------------------------------
	if (path === "/api/profile" && request.method === "POST") {
		const body = await request.json() as PlayerProfile;

		if (!body.username || !body.konamiId) {
			return json({ error: "username and konamiId required" }, 400);
		}

		await env.PLAYER_DB.prepare(
			`INSERT INTO players (username, konami_id, university, instagram, updated_at)
			 VALUES (?, ?, ?, ?, datetime('now'))
			 ON CONFLICT (username) DO UPDATE SET
			   konami_id = excluded.konami_id,
			   university = excluded.university,
			   instagram = excluded.instagram,
			   updated_at = datetime('now')`,
		)
			.bind(body.username, body.konamiId, body.university || "", body.instagram || "")
			.run();

		return json({ ok: true });
	}

	// -----------------------------------------------------------------------
	// GET /api/profile/:username — Get a player profile
	// -----------------------------------------------------------------------
	const profileMatch = path.match(/^\/api\/profile\/([^/]+)$/);
	if (profileMatch && request.method === "GET") {
		const username = decodeURIComponent(profileMatch[1]);

		const result = await env.PLAYER_DB.prepare(
			`SELECT username, konami_id as konamiId, university, instagram FROM players WHERE username = ?`,
		)
			.bind(username)
			.first();

		if (!result) {
			return json({ error: "Player not found" }, 404);
		}

		return json({ profile: result });
	}

	return null; // Not an API route
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------
export default {
	async fetch(request, env) {
		// Try API routes first
		const apiResponse = await handleApiRequest(request, env as AppEnv);
		if (apiResponse) return apiResponse;

		// Then try PartyKit WebSocket routes (chat only)
		return (
			(await routePartykitRequest(request, { ...env })) ||
			(env as AppEnv).ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<AppEnv>;
