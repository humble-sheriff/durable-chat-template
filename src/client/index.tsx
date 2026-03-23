import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import * as React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import {
	BrowserRouter,
	Routes,
	Route,
	Navigate,
	useParams,
	useNavigate,
} from "react-router";
import { nanoid } from "nanoid";

import type { ChatMessage, LfgMission, Message, PlayerProfile } from "../shared";

// -----------------------------------------------------------------------------
// Tactical Identity Interface (kept for local state)
// -----------------------------------------------------------------------------
interface UserProfile {
	username: string;
	konamiId: string;
	university: string;
	instagram: string;
}

// -----------------------------------------------------------------------------
// REST API Helpers
// -----------------------------------------------------------------------------
const api = {
	async getLfgBoard(): Promise<LfgMission[]> {
		try {
			const res = await fetch("/api/lfg");
			const data = await res.json();
			return (data as any).missions || [];
		} catch {
			return [];
		}
	},

	async postMission(room: string, username: string, konamiId: string): Promise<boolean> {
		try {
			const res = await fetch("/api/lfg", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ room, username, konamiId }),
			});
			return res.ok;
		} catch {
			return false;
		}
	},

	async joinMission(room: string, joinerUsername: string): Promise<{ commander: string; konamiId: string } | null> {
		try {
			const res = await fetch(`/api/lfg/${encodeURIComponent(room)}/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ joinerUsername }),
			});
			if (!res.ok) return null;
			const data = await res.json() as any;
			return { commander: data.commander, konamiId: data.konamiId };
		} catch {
			return null;
		}
	},

	async closeMission(room: string): Promise<boolean> {
		try {
			const res = await fetch(`/api/lfg/${encodeURIComponent(room)}/close`, {
				method: "POST",
			});
			return res.ok;
		} catch {
			return false;
		}
	},

	async pollAlerts(username: string): Promise<any | null> {
		try {
			const res = await fetch(`/api/lfg/alerts/${encodeURIComponent(username)}`);
			const data = await res.json() as any;
			return data.alert || null;
		} catch {
			return null;
		}
	},

	async syncProfile(profile: PlayerProfile): Promise<boolean> {
		try {
			const res = await fetch("/api/profile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(profile),
			});
			return res.ok;
		} catch {
			return false;
		}
	},

	async getProfile(username: string): Promise<PlayerProfile | null> {
		try {
			const res = await fetch(`/api/profile/${encodeURIComponent(username)}`);
			if (!res.ok) return null;
			const data = await res.json() as any;
			return data.profile || null;
		} catch {
			return null;
		}
	},
};

// -----------------------------------------------------------------------------
// Custom Hooks — Polling-based LFG
// -----------------------------------------------------------------------------
function useLfgBoard(intervalMs = 8000) {
	const [missions, setMissions] = useState<LfgMission[]>([]);

	const refresh = useCallback(async () => {
		const data = await api.getLfgBoard();
		setMissions(data);
	}, []);

	useEffect(() => {
		refresh(); // Immediate first fetch
		const id = setInterval(refresh, intervalMs);
		return () => clearInterval(id);
	}, [refresh, intervalMs]);

	return { missions, refresh };
}

function useLfgAlerts(username: string | undefined, onAlert: (msg: string) => void) {
	const onAlertRef = useRef(onAlert);
	onAlertRef.current = onAlert;

	useEffect(() => {
		if (!username) return;
		const id = setInterval(async () => {
			const alert = await api.pollAlerts(username);
			if (alert) {
				onAlertRef.current(alert.message || "INCOMING TACTICAL ALERT");
			}
		}, 5000);
		return () => clearInterval(id);
	}, [username]);
}

// -----------------------------------------------------------------------------
// Tactical Data Packing Helpers (chat messages only — LFG packing removed)
// -----------------------------------------------------------------------------
const packUser = (p: UserProfile) =>
	`${p.username}|${p.konamiId}|${p.university}|${p.instagram}`;

const unpackUser = (userStr: string): UserProfile => {
	const parts = userStr.split("|");
	return {
		username: parts[0] || "UNKNOWN",
		konamiId: parts[1] || "N/A",
		university: parts[2] || "N/A",
		instagram: parts[3] || "N/A",
	};
};

const packReply = (replyId: string, snippet: string, content: string) =>
	`[REPLY:${replyId}:${snippet}] ${content}`;

const unpackContent = (content: string) => {
	const match = content.match(/^\[REPLY:([^:]+):([^\]]+)\] (.*)$/);
	if (match) {
		return {
			isReply: true,
			replyId: match[1],
			snippet: match[2],
			text: match[3],
		};
	}
	return { isReply: false, text: content };
};

// -----------------------------------------------------------------------------
// Onboarding Modal Component
// -----------------------------------------------------------------------------
const OnboardingModal = ({
	onComplete,
}: { onComplete: (profile: UserProfile) => void }) => {
	const [formData, setFormData] = React.useState<UserProfile>({
		username: "",
		konamiId: "",
		university: "",
		instagram: "",
	});
	const [status, setStatus] = React.useState<"idle" | "scanning" | "success">(
		"idle",
	);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!formData.username) return;

		setStatus("scanning");

		setTimeout(async () => {
			setStatus("success");

			// Store in LocalStorage for local persistence
			localStorage.setItem("tactical_profile", JSON.stringify(formData));

			// Sync to D1 in background (fire-and-forget)
			api.syncProfile({
				username: formData.username,
				konamiId: formData.konamiId,
				university: formData.university,
				instagram: formData.instagram,
			});

			setTimeout(() => {
				onComplete(formData);
			}, 1000);
		}, 2000);
	};

	return (
		<div className="onboarding-overlay">
			<div className="onboarding-modal">
				<div className="modal-header">
					<div className="warning-blip"></div>
					<h2 className="retro-title">IDENTIFICATION REQUIRED</h2>
				</div>
				<div className="divider" style={{ width: "100%" }}></div>

				{status === "scanning" ? (
					<div className="scanning-container">
						<div className="scanning-line"></div>
						<p className="status-text">INITIALIZING AUTHENTICATION SEQUENCE...</p>
						<p className="status-sub">LOCATING BROWSER CREDENTIALS</p>
					</div>
				) : status === "success" ? (
					<div className="success-container">
						<p className="status-text" style={{ color: "var(--kenya-green)" }}>
							IDENTIFICATION VERIFIED
						</p>
						<p className="status-sub">CLEARANCE GRANTED: {formData.username}</p>
					</div>
				) : (
					<form className="onboarding-form" onSubmit={handleSubmit}>
						<div className="form-field">
							<label>TACTICAL USERNAME</label>
							<input
								required
								type="text"
								placeholder="e.g. GHOST_99"
								value={formData.username}
								onChange={(e) =>
									setFormData({ ...formData, username: e.target.value })
								}
							/>
							<p className="form-notice">MUST BE FROM KONAMI TO FIND OPPONENTS</p>
						</div>
						<div className="form-field">
							<label>KONAMI ID / DISPLAY NAME</label>
							<input
								required
								type="text"
								placeholder="KONAMI-XXXX-XXXX"
								value={formData.konamiId}
								onChange={(e) =>
									setFormData({ ...formData, konamiId: e.target.value })
								}
							/>
						</div>
						<div className="form-row">
							<div className="form-field">
								<label>UNIVERSITY</label>
								<input
									type="text"
									placeholder="e.g. UON"
									value={formData.university}
									onChange={(e) =>
										setFormData({ ...formData, university: e.target.value })
									}
								/>
							</div>
							<div className="form-field">
								<label>INSTAGRAM</label>
								<input
									type="text"
									placeholder="@handle"
									value={formData.instagram}
									onChange={(e) =>
										setFormData({ ...formData, instagram: e.target.value })
									}
								/>
							</div>
						</div>
						<button type="submit" className="send-btn" style={{ width: "100%" }}>
							START MISSION
						</button>
					</form>
				)}
			</div>
		</div>
	);
};

// -----------------------------------------------------------------------------
// Profile View Modal Component
// -----------------------------------------------------------------------------
const ProfileModal = ({
	profile,
	onClose,
}: { profile: UserProfile; onClose: () => void }) => {
	return (
		<div className="onboarding-overlay" onClick={onClose}>
			<div className="onboarding-modal profile-view" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<div className="status-dot"></div>
					<h2 className="retro-title">SQUAD MATE PROFILE</h2>
				</div>
				<div className="divider" style={{ width: "100%" }}></div>

				<div className="profile-data-grid">
					<div className="data-row">
						<label>USERNAME</label>
						<span>{profile.username}</span>
					</div>
					<div className="data-row">
						<label>KONAMI ID</label>
						<span>{profile.konamiId}</span>
					</div>
					<div className="data-row">
						<label>UNIVERSITY</label>
						<span>{profile.university}</span>
					</div>
					<div className="data-row">
						<label>INSTAGRAM</label>
						<span style={{ color: "var(--kenya-red)" }}>{profile.instagram}</span>
					</div>
				</div>

				<button className="send-btn" onClick={onClose} style={{ width: "100%", marginTop: "20px" }}>
					CLOSE COMM-LINK
				</button>
			</div>
		</div>
	);
};

// -----------------------------------------------------------------------------
// Tactical Alert Overlay
// -----------------------------------------------------------------------------
const TacticalAlert = ({ message, onClose }: { message: string; onClose: () => void }) => {
	return (
		<div className="onboarding-overlay" style={{ zIndex: 100000 }}>
			<div className="onboarding-modal tactical-alert">
				<div className="modal-header">
					<div className="warning-blip pulse"></div>
					<h2 className="retro-title">SIGNAL INTERCEPTED</h2>
				</div>
				<p className="alert-text">{message}</p>
				<button className="send-btn" onClick={onClose} style={{ width: "100%" }}>ACKNOWLEDGE</button>
			</div>
		</div>
	);
};

// -----------------------------------------------------------------------------
// Mission Board Component (LFG) — now reads from REST polling data
// -----------------------------------------------------------------------------
const LfgBoard = ({ missions, onPost, onJoin, currentUsername }: { missions: LfgMission[]; onPost: () => void, onJoin: (m: LfgMission) => void, currentUsername: string }) => {
	return (
		<div className="lfg-board">
			<div className="lfg-header">
				<h3 className="retro-subtitle">ACTIVE RADAR</h3>
				<button className="post-lfg-btn" onClick={onPost}>+ BROADCAST</button>
			</div>
			<div className="mission-list">
				{missions.length === 0 && <div className="no-missions">NO RECENT SIGNALS...</div>}
				{missions.map(m => (
					<div key={`${m.room}-${m.postedAt}`} className="mission-card">
						<div className="mission-info">
							<div className="mission-mode">SQUAD REQUEST</div>
							<div className="mission-user">COMMANDER: {m.username}</div>
						</div>
						<div className="mission-meta-row">
							<div className="mission-status">
								<span className="status-led green"></span>
								READY
							</div>
						</div>
						{m.username === currentUsername ? (
							<div className="admin-tag">MY SIGNAL</div>
						) : (
							<button className="join-mission-btn" onClick={() => onJoin(m)}>JOIN MISSION</button>
						)}
					</div>
				))}
			</div>
		</div>
	);
};

// -----------------------------------------------------------------------------
// Post LFG Modal
// -----------------------------------------------------------------------------
const LfgPostModal = ({ onClose, onPost, currentRoom, username }: { onClose: () => void, onPost: () => void, currentRoom: string, username: string }) => {
	return (
		<div className="onboarding-overlay">
			<div className="onboarding-modal medium">
				<div className="modal-header">
					<div className="warning-blip"></div>
					<h2 className="retro-title">BROADCAST SIGNAL</h2>
				</div>
				<div className="form-field">
					<label>SQUAD COMMANDER</label>
					<div className="status-label">{username}</div>
				</div>
				<div className="form-field">
					<label>TARGET DATA</label>
					<div className="status-label">ROOM: #{currentRoom}</div>
				</div>
				<p className="description-text" style={{ fontSize: '10px', color: '#666' }}>
					SIGNAL WILL PERSIST FOR 10 MINUTES OR UNTIL ONE SQUAD MATE JOINS.
				</p>
				<div className="form-row">
					<button className="send-btn" onClick={onPost} style={{ flex: 1 }}>INITIATE</button>
					<button className="send-btn" onClick={onClose} style={{ flex: 1, background: "#333", boxShadow: "0 4px 0px #111" }}>ABORT</button>
				</div>
			</div>
		</div>
	);
};

// -----------------------------------------------------------------------------
// Main App Component
// -----------------------------------------------------------------------------
function App() {
	const { room } = useParams();
	const navigate = useNavigate();
	const [profile, setProfile] = React.useState<UserProfile | null>(null);
	const [showOnboarding, setShowOnboarding] = React.useState(false);
	const [showLfgForm, setShowLfgForm] = React.useState(false);
	const [showLfgMobile, setShowLfgMobile] = React.useState(false);
	const [tacticalAlert, setTacticalAlert] = React.useState<string | null>(null);
	const [viewProfile, setViewProfile] = React.useState<UserProfile | null>(null);
	const [replyTo, setReplyTo] = React.useState<ChatMessage | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	// LFG Board — polling via REST (replaces the LFG_HUB WebSocket)
	const { missions: lfgMissions, refresh: refreshLfg } = useLfgBoard(8000);

	// LFG Alerts — polling for commander notifications
	useLfgAlerts(profile?.username, (msg) => {
		setTacticalAlert(msg);
	});

	// 1. Initial Identity Check
	React.useEffect(() => {
		const saved = localStorage.getItem("tactical_profile");
		if (saved) {
			try {
				const parsed = JSON.parse(saved);
				setProfile(parsed);
				// Auto-sync existing localStorage profile to D1
				api.syncProfile({
					username: parsed.username,
					konamiId: parsed.konamiId,
					university: parsed.university || "",
					instagram: parsed.instagram || "",
				});
			} catch (e) {
				setShowOnboarding(true);
			}
		} else {
			setShowOnboarding(true);
		}
	}, []);

	// 2. Main Chat Socket — ONLY socket now (no more LFG_HUB)
	const socket = usePartySocket({
		party: "chat",
		room,
		onMessage: (evt: MessageEvent) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "all") {
				setMessages(message.messages);
			} else if (message.type === "add") {
				setMessages((prev) => [...prev, message as unknown as ChatMessage]);
			}
		},
	});

	if (showOnboarding) {
		return (
			<OnboardingModal
				onComplete={(newProfile) => {
					setProfile(newProfile);
					setShowOnboarding(false);
				}}
			/>
		);
	}

	const myActiveMission = lfgMissions.find(m => m.room === room && m.username === profile?.username);

	return (
		<div className="row" style={{ height: "100%", margin: 0 }}>
			{tacticalAlert && (
				<TacticalAlert message={tacticalAlert} onClose={() => setTacticalAlert(null)} />
			)}
			{viewProfile && (
				<ProfileModal profile={viewProfile} onClose={() => setViewProfile(null)} />
			)}
			{showLfgForm && profile && (
				<LfgPostModal 
					username={profile.username}
					currentRoom={room || "lobby"}
					onClose={() => setShowLfgForm(false)}
					onPost={async () => {
						await api.postMission(room || "lobby", profile.username, profile.konamiId);
						setShowLfgForm(false);
						refreshLfg(); // Immediately refresh the board
					}}
				/>
			)}

			{/* Left Column: LFG Mission Board */}
			<div className={`one-third column description-panel ${showLfgMobile ? 'show-mobile' : ''}`}>
				<div className="status-item">
					<span className="status-dot"></span>
					<span className="status-label">SIGNAL: ENCRYPTED</span>
				</div>
				<h2 className="retro-title">MISSION BOARD</h2>
				<div className="match-timer" style={{ marginBottom: "20px" }}>LIVE: 90:00+</div>

				<LfgBoard 
					missions={lfgMissions} 
					onPost={() => setShowLfgForm(true)} 
					currentUsername={profile?.username || ""}
					onJoin={async (m) => {
						// 1. Join via REST API
						const result = await api.joinMission(m.room, profile?.username || "");
						if (!result) {
							setTacticalAlert("MISSION EXPIRED OR ALREADY CLAIMED BY ANOTHER OPERATOR.");
							refreshLfg();
							return;
						}

						// 2. Copy commander username to clipboard
						navigator.clipboard.writeText(result.commander).catch(() => {});

						// 3. Show local instruction
						setTacticalAlert("THE USERNAME HAS BEEN COPIED TO YOUR CLIPBOARD. SEARCH THE USERNAME, SEND A FRIEND REQUEST AND WAIT FOR THE OTHER MEMBER TO DECIDE THE MATCH (5 MINS LATEST).");

						// 4. Navigate to the mission room
						navigate(`/${m.room}`);
						setShowLfgMobile(false);

						// 5. Refresh board
						refreshLfg();
					}}
				/>

				<div className="stats-panel" style={{ marginTop: "30px" }}>
					<div className="status-item">
						<span className="status-dot"></span>
						<span className="status-label">ENCRYPTION: ACTIVE</span>
					</div>
					<div className="status-item">
						<span className="status-dot" style={{ background: "var(--kenya-red)", boxShadow: "0 0 6px var(--kenya-red)" }}></span>
						<span className="status-label">MATCH STATUS: KICKOFF</span>
					</div>
				</div>

				{showLfgMobile && (
					<button className="send-btn" onClick={() => setShowLfgMobile(false)} style={{ marginTop: "20px", width: "100%" }}>BACK TO COMMS</button>
				)}
				
				<div className="pitch-container desktop-only" style={{ opacity: 0.3, marginTop: "40px" }}>
					<div className="goal-box goal-top"></div>
					<div className="goal-box goal-bottom"></div>
				</div>
			</div>

			{/* Right Column: Chat Panel */}
			<div className="two-thirds column chat-panel">
				<div className="tactical-hud">
					<div className="hud-label">
						LOGGED AS: {profile?.username}
						<button className="mobile-only lfg-toggle-btn" onClick={() => setShowLfgMobile(true)}>
							LFG BOARD ({lfgMissions.length})
						</button>
						{myActiveMission && (
							<button 
								className="admin-close-btn" 
								onClick={async () => {
									await api.closeMission(room || "");
									refreshLfg();
								}}
							>
								[CLOSE MISSION]
							</button>
						)}
					</div>
					<div className="hud-meta">
						<span>ID: {profile?.konamiId || "N/A"}</span>
						<span>UNI: {profile?.university || "N/A"}</span>
					</div>
				</div>

				<div className="messages-list">
					{messages.map((message: ChatMessage) => {
						const unpackedU = unpackUser(message.user);
						const unpackedC = unpackContent(message.content);
						
						return (
							<div key={message.id} className="message-entry">
								<div className="message-content-wrapper">
									{unpackedC.isReply && (
										<div className="reply-quote">
											<span className="reply-marker">↵ RE:</span> {unpackedC.snippet}
										</div>
									)}
									<div className="username-line">
										<span className="username clickable" onClick={() => setViewProfile(unpackedU)}>
											{unpackedU.username}
										</span>
										<span className="reply-btn" onClick={() => setReplyTo({ ...message, content: unpackedC.text, user: message.user })}>
											REPLY
										</span>
									</div>
									<div className="content">{unpackedC.text}</div>
								</div>
							</div>
						);
					})}
				</div>

				{replyTo && (
					<div className="reply-preview">
						<div className="preview-label">REPLYING TO {unpackUser(replyTo.user).username}</div>
						<div className="preview-text">{unpackContent(replyTo.content).text}</div>
						<div className="cancel-reply" onClick={() => setReplyTo(null)}>×</div>
					</div>
				)}

				<form className="input-form" onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
					e.preventDefault();
					const contentInput = e.currentTarget.elements.namedItem("content") as HTMLInputElement;
					if (!contentInput.value.trim() || !profile) return;

					let finalContent = contentInput.value;
					if (replyTo) {
						const snippet = unpackContent(replyTo.content).text.substring(0, 30) + "...";
						finalContent = packReply(replyTo.id, snippet, contentInput.value);
					}

					socket.send(JSON.stringify({
						type: "add",
						id: nanoid(8),
						content: finalContent,
						user: packUser(profile),
						role: "user",
					} satisfies Message));

					contentInput.value = "";
					setReplyTo(null);
				}}>
					<input
						type="text"
						name="content"
						className="chat-input"
						placeholder={replyTo ? `REPLYING > ${unpackUser(replyTo.user).username}` : `SIGNAL > ${profile?.username || "..."}`}
						autoComplete="off"
					/>
					<button type="submit" className="send-btn">SEND</button>
				</form>
			</div>
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
	<BrowserRouter>
		<Routes>
			<Route path="/" element={<Navigate to={`/${nanoid()}`} />} />
			<Route path="/:room" element={<App />} />
			<Route path="*" element={<Navigate to="/" />} />
		</Routes>
	</BrowserRouter>,
);
