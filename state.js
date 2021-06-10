import * as irc from "./lib/irc.js";
import Client from "./lib/client.js";

export const SERVER_BUFFER = "*";

export const BufferType = {
	SERVER: "server",
	CHANNEL: "channel",
	NICK: "nick",
};

export const ServerStatus = Client.Status;

export const Unread = {
	NONE: "",
	MESSAGE: "message",
	HIGHLIGHT: "highlight",

	compare(a, b) {
		const priority = {
			[Unread.NONE]: 0,
			[Unread.MESSAGE]: 1,
			[Unread.HIGHLIGHT]: 2,
		};
		return priority[a] - priority[b];
	},
	union(a, b) {
		return (Unread.compare(a, b) > 0) ? a : b;
	},
};

export const ReceiptType = {
	DELIVERED: "delivered",
	READ: "read",
};

export function getNickURL(nick) {
	return "irc:///" + encodeURIComponent(nick) + ",isuser";
}

export function getChannelURL(channel) {
	return "irc:///" + encodeURIComponent(channel);
}

export function getBufferURL(buf) {
	switch (buf.type) {
	case BufferType.SERVER:
		return "irc:///";
	case BufferType.CHANNEL:
		return getChannelURL(buf.name);
	case BufferType.NICK:
		return getNickURL(buf.name);
	}
	throw new Error("Unknown buffer type: " + buf.type);
}

export function getMessageURL(buf, msg) {
	let bufURL = getBufferURL(buf);
	if (msg.tags.msgid) {
		return bufURL + "?msgid=" + encodeURIComponent(msg.tags.msgid);
	} else {
		return bufURL + "?timestamp=" + encodeURIComponent(msg.tags.time);
	}
}

export function getServerName(server, bouncerNetwork, isBouncer) {
	if (bouncerNetwork && bouncerNetwork.name) {
		return bouncerNetwork.name;
	}
	if (isBouncer) {
		return "bouncer";
	}

	let netName = server.isupport.get("NETWORK");
	if (netName) {
		return netName;
	}

	return "server";
}

function updateState(state, updater) {
	let updated;
	if (typeof updater === "function") {
		updated = updater(state, state);
	} else {
		updated = updater;
	}
	if (state === updated || !updated) {
		return;
	}
	return { ...state, ...updated };
}

function isServerBuffer(buf) {
	return buf.type == BufferType.SERVER;
}

/* Returns 1 if a should appear after b, -1 if a should appear before b, or
 * 0 otherwise. */
function compareBuffers(a, b) {
	if (a.server != b.server) {
		return a.server > b.server ? 1 : -1;
	}
	if (isServerBuffer(a) != isServerBuffer(b)) {
		return isServerBuffer(b) ? 1 : -1;
	}
	if (a.name != b.name) {
		return a.name > b.name ? 1 : -1;
	}
	return 0;
}

/* Insert a message in an immutable list of sorted messages. */
function insertMessage(list, msg) {
	if (list.length == 0) {
		return [msg];
	} else if (list[list.length - 1].tags.time <= msg.tags.time) {
		return list.concat(msg);
	}

	let insertBefore = -1;
	for (let i = 0; i < list.length; i++) {
		let other = list[i];
		if (msg.tags.time < other.tags.time) {
			insertBefore = i;
			break;
		}
	}
	console.assert(insertBefore >= 0, "");

	list = [ ...list ];
	list.splice(insertBefore, 0, msg);
	return list;
}

let lastServerID = 0;
let lastBufferID = 0;

export const State = {
	updateServer(state, id, updater) {
		let server = state.servers.get(id);
		if (!server) {
			return;
		}

		let updated = updateState(server, updater);
		if (!updated) {
			return;
		}

		let servers = new Map(state.servers);
		servers.set(id, updated);
		return { servers };
	},
	updateBuffer(state, id, updater) {
		let buf = State.getBuffer(state, id);
		if (!buf) {
			return;
		}

		let updated = updateState(buf, updater);
		if (!updated) {
			return;
		}

		let buffers = new Map(state.buffers);
		buffers.set(buf.id, updated);
		return { buffers };
	},
	getActiveServerID(state) {
		let buf = state.buffers.get(state.activeBuffer);
		if (!buf) {
			return null;
		}
		return buf.server;
	},
	getBuffer(state, id) {
		switch (typeof id) {
		case "number":
			return state.buffers.get(id);
		case "object":
			if (id.id) {
				return state.buffers.get(id.id);
			}

			let serverID = id.server, name = id.name;
			if (!serverID) {
				serverID = State.getActiveServerID(state);
			}
			if (!name) {
				name = SERVER_BUFFER;
			}

			let cm = irc.CaseMapping.RFC1459;
			let server = state.servers.get(serverID);
			if (server) {
				cm = irc.CaseMapping.byName(server.isupport.get("CASEMAPPING")) || cm;
			}

			let nameCM = cm(name);
			for (let buf of state.buffers.values()) {
				if (buf.server === serverID && cm(buf.name) === nameCM) {
					return buf;
				}
			}
			return null;
		default:
			throw new Error("Invalid buffer ID type: " + (typeof id));
		}
	},
	createServer(state) {
		lastServerID++;
		let id = lastServerID;

		let servers = new Map(state.servers);
		servers.set(id, {
			id,
			status: ServerStatus.DISCONNECTED,
			isupport: new Map(),
		});
		return [id, { servers }];
	},
	createBuffer(state, name, serverID, client) {
		let buf = State.getBuffer(state, { server: serverID, name });
		if (buf) {
			return [buf.id, null];
		}

		lastBufferID++;
		let id = lastBufferID;

		let type;
		if (name == SERVER_BUFFER) {
			type = BufferType.SERVER;
		} else if (client.isChannel(name)) {
			type = BufferType.CHANNEL;
		} else {
			type = BufferType.NICK;
		}

		let bufferList = Array.from(state.buffers.values());
		bufferList.push({
			id,
			name,
			type,
			server: serverID,
			serverInfo: null, // if server
			topic: null, // if channel
			members: new irc.CaseMapMap(null, client.cm), // if channel
			who: null, // if nick
			offline: false, // if nick
			messages: [],
			unread: Unread.NONE,
		});
		bufferList = bufferList.sort(compareBuffers);
		let buffers = new Map(bufferList.map((buf) => [buf.id, buf]));
		return [id, { buffers }];
	},
	handleMessage(state, msg, serverID, client) {
		function updateServer(updater) {
			return State.updateServer(state, serverID, updater);
		}
		function updateBuffer(name, updater) {
			return State.updateBuffer(state, { server: serverID, name }, updater);
		}

		// Don't update our internal state if it's a chat history message
		if (irc.findBatchByType(msg, "chathistory")) {
			return;
		}

		let channel, topic;
		switch (msg.command) {
		case irc.RPL_MYINFO:
			// TODO: parse available modes
			let serverInfo = {
				name: msg.params[1],
				version: msg.params[2],
			};
			return updateBuffer(SERVER_BUFFER, { serverInfo });
		case irc.RPL_ISUPPORT:
			let buffers = new Map(state.buffers);
			state.buffers.forEach((buf) => {
				if (buf.server != serverID) {
					return;
				}
				let members = new irc.CaseMapMap(buf.members, client.cm);
				buffers.set(buf.id, { ...buf, members });
			});
			return {
				buffers,
				...updateServer({ isupport: new Map(client.isupport) }),
			};
		case irc.RPL_NOTOPIC:
			channel = msg.params[1];
			return updateBuffer(channel, { topic: null });
		case irc.RPL_TOPIC:
			channel = msg.params[1];
			topic = msg.params[2];
			return updateBuffer(channel, { topic });
		case irc.RPL_TOPICWHOTIME:
			// Ignore
			break;
		case irc.RPL_NAMREPLY:
			channel = msg.params[2];
			let membersList = msg.params[3].split(" ");

			return updateBuffer(channel, (buf) => {
				let members = new irc.CaseMapMap(buf.members);
				membersList.forEach((s) => {
					let member = irc.parseTargetPrefix(s);
					members.set(member.name, member.prefix);
				});
				return { members };
			});
		case irc.RPL_ENDOFNAMES:
			break;
		case irc.RPL_WHOREPLY:
			let last = msg.params[msg.params.length - 1];
			let who = {
				username: msg.params[2],
				hostname: msg.params[3],
				server: msg.params[4],
				nick: msg.params[5],
				away: msg.params[6] == 'G', // H for here, G for gone
				realname: last.slice(last.indexOf(" ") + 1),
			};
			return updateBuffer(who.nick, { who, offline: false });
		case irc.RPL_ENDOFWHO:
			let target = msg.params[1];
			if (!client.isChannel(target) && target.indexOf("*") < 0) {
				// Not a channel nor a mask, likely a nick
				return updateBuffer(target, (buf) => {
					// TODO: mark user offline if we have old WHO info but this
					// WHO reply is empty
					if (buf.who) {
						return;
					}
					return { offline: true };
				});
			}
			break;
		case "JOIN":
			channel = msg.params[0];

			if (client.isMyNick(msg.prefix.name)) {
				let [id, update] = State.createBuffer(state, channel, serverID, client);
				state = { ...state, ...update };
			}

			let update = updateBuffer(channel, (buf) => {
				let members = new irc.CaseMapMap(buf.members);
				members.set(msg.prefix.name, "");
				return { members };
			});
			return { ...state, ...update };
		case "PART":
			channel = msg.params[0];

			return updateBuffer(channel, (buf) => {
				let members = new irc.CaseMapMap(buf.members);
				members.delete(msg.prefix.name);
				return { members };
			});
		case "KICK":
			channel = msg.params[0];
			let nick = msg.params[1];

			return updateBuffer(channel, (buf) => {
				let members = new irc.CaseMapMap(buf.members);
				members.delete(nick);
				return { members };
			});
		case "SETNAME":
			return updateBuffer(msg.prefix.name, (buf) => {
				let who = { ...buf.who, realname: msg.params[0] };
				return { who };
			});
		case "AWAY":
			let awayMessage = msg.params[0];

			return updateBuffer(msg.prefix.name, (buf) => {
				let who = { ...buf.who, away: !!awayMessage };
				return { who };
			});
		case "TOPIC":
			channel = msg.params[0];
			topic = msg.params[1];
			return updateBuffer(channel, { topic });
		}
	},
	addMessage(state, msg, bufID) {
		return State.updateBuffer(state, bufID, (buf) => {
			let messages = insertMessage(buf.messages, msg);
			return { messages };
		});
	},
};
