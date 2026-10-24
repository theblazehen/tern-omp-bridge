import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolRenderResultOptions,
} from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { col, stableKey, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { registerNativeStyle } from "@oh-my-pi/pi-tui/native/styles";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import { logger } from "@oh-my-pi/pi-utils";
import type { TspKind, TspProps } from "@oh-my-pi/pi-wire";
import toolPrompt from "./tool.md" with { type: "text" };

const MESSAGE_TYPE = "tern-bridge-event";
const MAX_CODE_BYTES = 256 * 1024;
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const MAX_NODE_COUNT = 8_000;
const MAX_NODE_DEPTH = 40;
const MAX_VIEW_ID_BYTES = 128;
/** Per view; Tern caps a surface's sheets at 256 KiB in total. */
const MAX_CSS_BYTES = 32 * 1024;
const MAX_PENDING_JOBS = 128;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 300;
const CALLBACK_TIMEOUT_MS = 30_000;
const LONG_POLL_MS = 19_000;
const CLIENT_LEASE_MS = 35_000;
const SHUTDOWN_DISPOSE_MS = 750;
const EMPTY_ROWS: readonly string[] = [];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type UpstreamNode = {
	k: string;
	p?: { [key: string]: JsonValue };
	c?: UpstreamNode[];
	[key: string]: JsonValue | UpstreamNode[] | { [key: string]: JsonValue } | undefined;
};

type ViewSnapshot = {
	id: string;
	view: UpstreamNode;
	title?: string;
	/** Program stylesheet for the view's `el` nodes, installed on omp's surface. */
	css?: string;
	ownerCallId: string;
};

type BridgeEffect =
	| { type: "show"; id: string; view: UpstreamNode; title?: string; css?: string }
	| { type: "close"; id: string }
	| { type: "emit"; data: JsonValue };

type ExecDetails = {
	bridgeId: string;
	callId: string;
	views: ViewSnapshot[];
	result?: JsonValue;
	action?: JsonValue;
	error?: string;
};

type Completion = {
	ok: boolean;
	value?: JsonValue;
	error?: string;
};

type ExecJob = { id: string; op: "exec"; code: string };
type ActionJob = { id: string; op: "action"; view: string; event: NativeUiEvent };
type DisposeJob = { id: string; op: "dispose" };
type BridgeJob = ExecJob | ActionJob | DisposeJob;

type PendingJob = {
	id: string;
	job: BridgeJob;
	callId: string;
	status: "queued" | "sent" | "settled";
	client?: string;
	timer: NodeJS.Timeout;
	resolve: (completion: Completion) => void;
	reject: (error: Error) => void;
	abortSignal?: AbortSignal;
	abortHandler?: () => void;
	waiter?: ActionWaiter;
	waiterTimeoutMs?: number;
};

type LongPoll = {
	client: string;
	resolve: (response: Response) => void;
	timer: NodeJS.Timeout;
	abortSignal: AbortSignal;
	abortHandler: () => void;
};

type ActionWaiter = {
	armed: boolean;
	settled: boolean;
	promise: Promise<JsonValue>;
	resolve: (data: JsonValue) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	abortSignal?: AbortSignal;
	abortHandler?: () => void;
};

type ActiveView = { snapshot: ViewSnapshot };

interface BridgeState {
	id: string;
	managerSessionId: string;
	pane: number;
	socket: string;
	token: string;
	url: string;
	registrationPath: string;
	server?: Bun.Server<unknown>;
	ui: ExtensionUIContext;
	widgetKey: string;
	widgetRegistered: boolean;
	alive: boolean;
	closing: boolean;
	closed: boolean;
	client?: string;
	leaseExpiresAt: number;
	poll?: LongPoll;
	queue: PendingJob[];
	pending: Map<string, PendingJob>;
	actionWaiter?: ActionWaiter;
	views: Map<string, ActiveView>;
	hosts: Map<string, InlineViewHost>;
	components: Map<string, Map<string, InlineViewComponent>>;
	updates: Map<string, AgentToolUpdateCallback<ExecDetails>>;
	activeCallId?: string;
	revision: number;
	tui?: TUI;
	shutdown: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > MAX_NODE_DEPTH) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
	if (!isRecord(value)) return false;
	return Object.values(value).every(item => isJsonValue(item, depth + 1));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function timeoutSeconds(value: number | undefined): number {
	const seconds = value ?? DEFAULT_TIMEOUT_SECONDS;
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
		throw new Error(`timeout must be an integer from 1 to ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return seconds;
}

function jsonResponse(value: JsonValue, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

function httpError(status: number, message: string): Response {
	return new Response(message, { status, headers: { "cache-control": "no-store" } });
}

async function readJson(request: Request): Promise<unknown> {
	const length = Number(request.headers.get("content-length") ?? 0);
	if (Number.isFinite(length) && length > MAX_HTTP_BODY_BYTES) throw new Error("request body is too large");
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_HTTP_BODY_BYTES) throw new Error("request body is too large");
	const parsed: unknown = JSON.parse(body);
	return parsed;
}

function viewId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_VIEW_ID_BYTES) {
		throw new Error(`view id must be a non-empty string of at most ${MAX_VIEW_ID_BYTES} bytes`);
	}
	return value;
}

function parseUpstreamNode(value: unknown, depth = 0, count = { value: 0 }): UpstreamNode {
	if (depth > MAX_NODE_DEPTH) throw new Error(`native view exceeds ${MAX_NODE_DEPTH} levels`);
	if (++count.value > MAX_NODE_COUNT) throw new Error(`native view exceeds ${MAX_NODE_COUNT} nodes`);
	if (!isRecord(value) || typeof value.k !== "string" || value.k.length === 0) {
		throw new Error("native view node must have a string k field");
	}
	const nodeValue: UpstreamNode = { k: value.k };
	if (value.p !== undefined) {
		if (!isRecord(value.p) || !isJsonValue(value.p)) throw new Error("native view p must be a JSON object");
		nodeValue.p = value.p as { [key: string]: JsonValue };
	}
	if (value.c !== undefined) {
		if (!Array.isArray(value.c)) throw new Error("native view c must be an array");
		nodeValue.c = value.c.map(child => parseUpstreamNode(child, depth + 1, count));
	}
	for (const [key, child] of Object.entries(value)) {
		if (key === "k" || key === "p" || key === "c") continue;
		if (!isJsonValue(child)) throw new Error(`native view field ${key} is not JSON-safe`);
		nodeValue[key] = child;
	}
	return nodeValue;
}

function disabledItems(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(disabledItems);
	if (!isRecord(value)) return value;
	const result: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "actions" || key === "href") continue;
		result[key] = disabledItems(child);
	}
	if (("id" in result || "label" in result) && !("disabled" in result)) result.disabled = true;
	return result;
}

function toNativeNode(
	upstream: UpstreamNode,
	interactive: boolean,
	path: string,
	depth = 0,
	count = { value: 0 },
): NativeNode {
	if (depth > MAX_NODE_DEPTH || ++count.value > MAX_NODE_COUNT) throw new Error("native view exceeded its shape limits");
	const props: { [key: string]: JsonValue } = { ...(upstream.p ?? {}) };
	const sourceKey = Object.hasOwn(props, "key") ? props.key : upstream.key;
	if (sourceKey !== undefined && typeof sourceKey !== "string") throw new Error("native node key must be a string");
	delete props.key;
	if (!interactive) {
		// A superseded or replayed view stays on screen but takes no input.
		delete props.actions;
		for (const key of Object.keys(props)) {
			const value = props[key];
			if (value !== undefined) props[key] = disabledItems(value);
		}
		if (upstream.k === "editor" || upstream.k === "input") props.readonly = true;
		if (upstream.k === "el" && props.tag === "input") props.disabled = true;
	}
	const nativeKey = typeof sourceKey === "string" ? stableKey(`${path}/${sourceKey}`) : undefined;
	const children = upstream.c?.map((child, index) =>
		toNativeNode(child, interactive, `${path}/${nativeKey ?? index}`, depth + 1, count),
	);
	const native: Record<string, unknown> = {
		...upstream,
		k: upstream.k as TspKind,
		p: Object.keys(props).length > 0 ? (props as TspProps) : undefined,
		c: children,
	};
	if (nativeKey !== undefined) native.key = nativeKey;
	else delete native.key;
	return native as NativeNode;
}

function parseEffect(value: unknown): BridgeEffect {
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("effect must have a type");
	if (value.type === "show") {
		const id = viewId(value.id);
		if (value.title !== undefined && typeof value.title !== "string") throw new Error("show title must be a string");
		if (value.css !== undefined && typeof value.css !== "string") throw new Error("show css must be a string");
		if (typeof value.css === "string" && Buffer.byteLength(value.css) > MAX_CSS_BYTES) {
			throw new Error(`show css exceeds ${MAX_CSS_BYTES} bytes`);
		}
		return {
			type: "show",
			id,
			view: parseUpstreamNode(value.view),
			...(typeof value.title === "string" ? { title: value.title } : {}),
			...(typeof value.css === "string" && value.css.length > 0 ? { css: value.css } : {}),
		};
	}
	if (value.type === "close") return { type: "close", id: viewId(value.id) };
	if (value.type === "emit") {
		if (!isJsonValue(value.data)) throw new Error("emit data must be JSON-safe");
		return { type: "emit", data: value.data };
	}
	throw new Error(`unsupported bridge effect type: ${value.type}`);
}

function parseEffects(value: unknown): BridgeEffect[] {
	if (!Array.isArray(value)) throw new Error("complete/effects payload needs an effects array");
	return value.map(parseEffect);
}

function createActionWaiter(signal: AbortSignal | undefined): ActionWaiter {
	let resolveAction!: (data: JsonValue) => void;
	let rejectAction!: (error: Error) => void;
	const promise = new Promise<JsonValue>((resolve, reject) => {
		resolveAction = resolve;
		rejectAction = reject;
	});
	void promise.catch(() => {});
	const waiter: ActionWaiter = {
		armed: false,
		settled: false,
		promise,
		resolve: data => {
			if (waiter.settled) return;
			waiter.settled = true;
			resolveAction(data);
		},
		reject: error => {
			if (waiter.settled) return;
			waiter.settled = true;
			rejectAction(error);
		},
		abortSignal: signal,
	};
	if (signal) {
		waiter.abortHandler = () => {
			if (waiter.armed) waiter.reject(new DOMException("Tern action wait cancelled", "AbortError"));
		};
		signal.addEventListener("abort", waiter.abortHandler, { once: true });
	}
	return waiter;
}

function clearWaiter(state: BridgeState, waiter: ActionWaiter, result?: JsonValue): void {
	clearTimeout(waiter.timer);
	waiter.timer = undefined;
	if (waiter.abortSignal && waiter.abortHandler) waiter.abortSignal.removeEventListener("abort", waiter.abortHandler);
	if (!waiter.settled) waiter.resolve(result ?? null);
	if (state.actionWaiter === waiter) state.actionWaiter = undefined;
}

function armWaiter(state: BridgeState, waiter: ActionWaiter, timeoutMs: number): void {
	if (waiter.settled || state.actionWaiter !== waiter) return;
	waiter.armed = true;
	if (waiter.abortSignal?.aborted) {
		waiter.reject(new DOMException("Tern action wait cancelled", "AbortError"));
		return;
	}
	waiter.timer = setTimeout(() => waiter.reject(new Error("Timed out waiting for a Tern UI action")), timeoutMs);
}

function removePending(state: BridgeState, pending: PendingJob): void {
	if (pending.status === "settled") return;
	pending.status = "settled";
	clearTimeout(pending.timer);
	if (pending.abortSignal && pending.abortHandler) pending.abortSignal.removeEventListener("abort", pending.abortHandler);
	state.pending.delete(pending.id);
	state.queue = state.queue.filter(candidate => candidate !== pending);
}

function resolvePending(state: BridgeState, pending: PendingJob, completion: Completion): void {
	removePending(state, pending);
	pending.resolve(completion);
}

function rejectPending(state: BridgeState, pending: PendingJob, error: Error): void {
	removePending(state, pending);
	pending.reject(error);
}

function takeQueuedJob(state: BridgeState, client: string): PendingJob | undefined {
	while (state.queue.length > 0) {
		const pending = state.queue.shift();
		if (!pending || pending.status !== "queued") continue;
		if (state.closing && pending.job.op !== "dispose") {
			rejectPending(state, pending, new Error("Tern bridge session is closing"));
			continue;
		}
		pending.status = "sent";
		pending.client = client;
		return pending;
	}
	return undefined;
}

function dispatchPoll(state: BridgeState, client: string): void {
	const poll = state.poll;
	if (!poll || poll.client !== client) return;
	const pending = takeQueuedJob(state, client);
	if (!pending) return;
	clearTimeout(poll.timer);
	poll.abortSignal.removeEventListener("abort", poll.abortHandler);
	state.poll = undefined;
	poll.resolve(jsonResponse(pending.job as unknown as JsonValue));
}

function hasUnfinishedJobForClient(state: BridgeState, client: string): boolean {
	return [...state.pending.values()].some(pending => pending.status === "sent" && pending.client === client);
}

function claimClient(state: BridgeState, client: string): boolean {
	const now = Date.now();
	if (state.client !== undefined && state.client !== client && state.leaseExpiresAt > now) return false;
	if (state.client !== undefined && state.client !== client && hasUnfinishedJobForClient(state, state.client)) return false;
	state.client = client;
	state.leaseExpiresAt = now + CLIENT_LEASE_MS;
	return true;
}

function createPendingJob(
	state: BridgeState,
	job: BridgeJob,
	callId: string,
	timeoutMs: number,
	signal?: AbortSignal,
	waiter?: ActionWaiter,
	waiterTimeoutMs?: number,
): Promise<Completion> {
	if (state.closed || (state.closing && job.op !== "dispose")) return Promise.reject(new Error("Tern bridge session has ended"));
	if (state.pending.size >= MAX_PENDING_JOBS) return Promise.reject(new Error("Tern bridge request queue is full"));
	if (signal?.aborted) return Promise.reject(new DOMException("Tern request cancelled", "AbortError"));
	const id = randomUUID();
	const assignedJob: BridgeJob = { ...job, id };
	return new Promise<Completion>((resolve, reject) => {
		const pending: PendingJob = {
			id,
			job: assignedJob,
			callId,
			status: "queued",
			timer: setTimeout(() => rejectPending(state, pending, new Error("Tern bridge request expired")), timeoutMs),
			resolve,
			reject,
			...(signal ? { abortSignal: signal } : {}),
			...(waiter ? { waiter } : {}),
			...(waiterTimeoutMs !== undefined ? { waiterTimeoutMs } : {}),
		};
		if (signal) {
			pending.abortHandler = () => rejectPending(state, pending, new DOMException("Tern request cancelled", "AbortError"));
			signal.addEventListener("abort", pending.abortHandler, { once: true });
		}
		state.pending.set(id, pending);
		state.queue.push(pending);
		if (state.client && state.leaseExpiresAt > Date.now()) dispatchPoll(state, state.client);
	});
}

function detailsFor(state: BridgeState, callId: string): ExecDetails {
	const views = Array.from(state.views.values(), entry => entry.snapshot).filter(snapshot => snapshot.ownerCallId === callId);
	return { bridgeId: state.id, callId, views };
}

function refresh(state: BridgeState, callId?: string): void {
	state.revision++;
	if (callId) {
		const callback = state.updates.get(callId);
		if (callback) {
			try {
				callback({ content: [], details: detailsFor(state, callId) });
			} catch (error) {
				logger.warn(`Tern bridge update failed: ${errorMessage(error)}`);
			}
		}
	}
	try {
		state.tui?.requestRender();
	} catch {
		// A closing TUI is no longer a render target.
	}
}

function sendAside(pi: ExtensionAPI, state: BridgeState, data: JsonValue): void {
	if (!state.alive || state.closed) return;
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: JSON.stringify(data),
			display: false,
			details: { bridgeId: state.id, event: data },
		},
		{ deliverAs: "aside" },
	);
}

function applyEffect(
	pi: ExtensionAPI,
	state: BridgeState,
	effect: BridgeEffect,
	callId: string | undefined,
): void {
	if (!state.alive || state.closed) return;
	if (effect.type === "show") {
		const existing = state.views.get(effect.id)?.snapshot;
		const ownerCallId = callId ?? existing?.ownerCallId ?? state.activeCallId ?? "async";
		const snapshot: ViewSnapshot = {
			id: effect.id,
			view: effect.view,
			ownerCallId,
			...(effect.title !== undefined ? { title: effect.title } : {}),
			...(effect.css !== undefined ? { css: effect.css } : {}),
		};
		state.views.set(effect.id, { snapshot });
		if (existing && existing.ownerCallId !== ownerCallId &&
			!Array.from(state.views.values()).some(entry => entry.snapshot.ownerCallId === existing.ownerCallId)) {
			state.hosts.delete(existing.ownerCallId);
			state.components.delete(existing.ownerCallId);
		}
		refresh(state, ownerCallId);
		return;
	}
	if (effect.type === "close") {
		const existing = state.views.get(effect.id)?.snapshot;
		const ownerCallId = existing?.ownerCallId ?? callId;
		state.views.delete(effect.id);
		if (existing) {
			const components = state.components.get(existing.ownerCallId);
			components?.delete(effect.id);
			if (components?.size === 0) state.components.delete(existing.ownerCallId);
			if (!Array.from(state.views.values()).some(entry => entry.snapshot.ownerCallId === existing.ownerCallId)) {
				state.hosts.delete(existing.ownerCallId);
				state.components.delete(existing.ownerCallId);
			}
		}
		refresh(state, ownerCallId);
		return;
	}
	const waiter = state.actionWaiter;
	if (waiter?.armed && !waiter.settled) {
		clearWaiter(state, waiter, effect.data);
		return;
	}
	try {
		sendAside(pi, state, effect.data);
	} catch (error) {
		logger.warn(`Tern bridge aside delivery failed: ${errorMessage(error)}`);
	}
}

type ParsedCompletion = {
	id: string;
	ok: boolean;
	value?: JsonValue;
	error?: string;
	effects: BridgeEffect[];
};

function parseCompletion(value: unknown): ParsedCompletion {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.ok !== "boolean") {
		throw new Error("completion must contain id and boolean ok");
	}
	const effects = parseEffects(value.effects);
	if (value.value !== undefined && !isJsonValue(value.value)) throw new Error("completion value is not JSON-safe");
	if (value.error !== undefined && typeof value.error !== "string") throw new Error("completion error must be a string");
	return {
		id: value.id,
		ok: value.ok,
		...(value.value !== undefined ? { value: value.value } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		effects,
	};
}

function leasePinned(state: BridgeState, client: string): boolean {
	return state.client === client || hasUnfinishedJobForClient(state, client);
}

function authorized(request: Request, state: BridgeState): boolean {
	return request.headers.get("authorization") === `Bearer ${state.token}`;
}

function handleNext(state: BridgeState, request: Request, client: string): Promise<Response> {
	if (!client || client.length > 128) return Promise.resolve(httpError(400, "client id is required"));
	if (!claimClient(state, client)) return Promise.resolve(httpError(409, "another Tern window owns this OMP session"));
	if (state.closed) return Promise.resolve(httpError(410, "OMP session ended"));
	const immediate = takeQueuedJob(state, client);
	if (immediate) return Promise.resolve(jsonResponse(immediate.job as unknown as JsonValue));
	if (state.poll) {
		if (state.poll.client === client) return Promise.resolve(new Response(null, { status: 204 }));
		return Promise.resolve(httpError(409, "another Tern poll is active"));
	}
	return new Promise<Response>(resolve => {
		const abortSignal = request.signal;
		const abortHandler = () => {
			if (state.poll?.client !== client) return;
			clearTimeout(state.poll.timer);
			state.poll = undefined;
			resolve(new Response(null, { status: 204 }));
		};
		const poll: LongPoll = {
			client,
			resolve,
			timer: setTimeout(() => {
				if (state.poll !== poll) return;
				state.poll = undefined;
				abortSignal.removeEventListener("abort", abortHandler);
				resolve(new Response(null, { status: 204 }));
			}, LONG_POLL_MS),
			abortSignal,
			abortHandler,
		};
		state.poll = poll;
		abortSignal.addEventListener("abort", abortHandler, { once: true });
		// The request may have been aborted between the initial check and listener registration.
		if (abortSignal.aborted) abortHandler();
	});
}

async function handleComplete(pi: ExtensionAPI, state: BridgeState, request: Request): Promise<Response> {
	let raw: unknown;
	try {
		raw = await readJson(request);
	} catch (error) {
		logger.warn(`Tern bridge ignored malformed completion: ${errorMessage(error)}`);
		return new Response(null, { status: 200 });
	}
	const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;
	const pending = id ? state.pending.get(id) : undefined;
	// Aborted, expired and replayed completions are acknowledged so the Tern plugin
	// keeps its window session; their effects cannot escape into a newer request.
	if (!pending || pending.status !== "sent" || !pending.client || !leasePinned(state, pending.client)) {
		return new Response(null, { status: 200 });
	}
	let completion: ParsedCompletion;
	try {
		completion = parseCompletion(raw);
	} catch (error) {
		const message = errorMessage(error);
		rejectPending(state, pending, new Error(`Invalid Tern completion: ${message}`));
		return new Response(null, { status: 200 });
	}
	state.leaseExpiresAt = Date.now() + CLIENT_LEASE_MS;
	for (const effect of completion.effects) applyEffect(pi, state, effect, pending.callId);
	if (pending.waiter) {
		if (completion.ok && pending.job.op === "exec") armWaiter(state, pending.waiter, pending.waiterTimeoutMs ?? 0);
		else clearWaiter(state, pending.waiter);
	}
	resolvePending(state, pending, {
		ok: completion.ok,
		...(completion.value !== undefined ? { value: completion.value } : { value: null }),
		...(completion.error !== undefined ? { error: completion.error } : {}),
	});
	return new Response(null, { status: 200 });
}

async function handleEffects(pi: ExtensionAPI, state: BridgeState, request: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await readJson(request);
	} catch (error) {
		logger.warn(`Tern bridge ignored malformed effects: ${errorMessage(error)}`);
		return new Response(null, { status: 200 });
	}
	if (!isRecord(body)) return new Response(null, { status: 200 });
	let effects: BridgeEffect[];
	try {
		effects = parseEffects(body.effects);
	} catch (error) {
		logger.warn(`Tern bridge ignored invalid effects: ${errorMessage(error)}`);
		return new Response(null, { status: 200 });
	}
	if (!state.alive || state.closed || state.closing) return new Response(null, { status: 200 });
	for (const effect of effects) applyEffect(pi, state, effect, undefined);
	return new Response(null, { status: 200 });
}

function createServer(pi: ExtensionAPI, state: BridgeState): Bun.Server<unknown> {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 30,
		async fetch(request): Promise<Response> {
			const path = new URL(request.url).pathname;
			if (!authorized(request, state)) return httpError(401, "unauthorized");
			if (state.closed) return path === "/complete" || path === "/effects" ? new Response(null, { status: 200 }) : httpError(410, "OMP session ended");
			if (path === "/next" && request.method === "GET") {
				const client = new URL(request.url).searchParams.get("client") ?? "";
				return handleNext(state, request, client);
			}
			if (path === "/complete" && request.method === "POST") return handleComplete(pi, state, request);
			if (path === "/effects" && request.method === "POST") return handleEffects(pi, state, request);
			return httpError(404, "not found");
		},
	});
}

function makeUiWidget(state: BridgeState): (tui: TUI) => Component {
	return tui => {
		state.tui = tui;
		return {
			render: (_width: number) => EMPTY_ROWS,
			describe: () => col([]),
			dispose: () => {
				if (state.tui === tui) state.tui = undefined;
			},
		};
	};
}

async function startBridge(pi: ExtensionAPI, ctx: ExtensionContext): Promise<BridgeState | undefined> {
	const paneValue = process.env.TERN_PANE;
	const pane = Number(paneValue);
	const socket = process.env.TERN_PANE_SOCKET ?? process.env.TERN_DAEMON_SOCKET;
	if (!paneValue?.trim() || !/^\d+$/.test(paneValue) || !Number.isSafeInteger(pane) || !socket) return undefined;
	const id = randomUUID();
	const token = randomBytes(32).toString("hex");
	// Same rule as the window plugin: the runtime directory when set, else a private cache directory.
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
	const directory = runtimeDirectory
		? path.join(runtimeDirectory, "omp-tern")
		: path.join(os.homedir(), ".cache", "omp-tern");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
	const registrationPath = path.join(directory, `${id}.json`);
	const widgetKey = `tern-bridge-${id}`;
	const state: BridgeState = {
		id,
		managerSessionId: ctx.sessionManager.getSessionId(),
		pane,
		socket,
		token,
		url: "",
		registrationPath,
		ui: ctx.ui,
		widgetKey,
		widgetRegistered: ctx.mode === "tui",
		alive: true,
		closing: false,
		closed: false,
		leaseExpiresAt: 0,
		queue: [],
		pending: new Map<string, PendingJob>(),
		views: new Map<string, ActiveView>(),
		hosts: new Map<string, InlineViewHost>(),
		components: new Map<string, Map<string, InlineViewComponent>>(),
		updates: new Map<string, AgentToolUpdateCallback<ExecDetails>>(),
		revision: 0,
		shutdown: new AbortController(),
	};
	const server = createServer(pi, state);
	if (typeof server.port !== "number") {
		server.stop(true);
		throw new Error("Tern bridge did not receive a TCP port");
	}
	state.server = server;
	state.url = `http://127.0.0.1:${server.port}`;
	try {
		await fs.writeFile(
			registrationPath,
			JSON.stringify({ version: 1, id, pane, socket, url: state.url, token }),
			{ mode: 0o600, flag: "wx" },
		);
		await fs.chmod(registrationPath, 0o600);
		if (state.widgetRegistered) ctx.ui.setWidget(widgetKey, makeUiWidget(state), { placement: "hud" });
		return state;
	} catch (error) {
		state.closed = true;
		server.stop(true);
		await fs.rm(registrationPath, { force: true }).catch(() => {});
		throw error;
	}
}

let activeBridge: BridgeState | undefined;
let startingBridge: Promise<BridgeState | undefined> | undefined;

async function ensureBridge(pi: ExtensionAPI, ctx: ExtensionContext): Promise<BridgeState> {
	const managerSessionId = ctx.sessionManager.getSessionId();
	if (activeBridge?.alive && activeBridge.managerSessionId === managerSessionId) return activeBridge;
	if (activeBridge) await stopBridge(activeBridge);
	if (!startingBridge) {
		startingBridge = startBridge(pi, ctx).then(state => {
			activeBridge = state;
			return state;
		});
	}
	try {
		const state = await startingBridge;
		if (!state) throw new Error("tern_exec requires TERN_PANE and TERN_PANE_SOCKET or TERN_DAEMON_SOCKET");
		return state;
	} finally {
		startingBridge = undefined;
	}
}

async function stopBridge(state: BridgeState | undefined = activeBridge): Promise<void> {
	if (!state) {
		const startup = startingBridge;
		if (!startup) return;
		const started = await startup.catch(() => undefined);
		if (started) await stopBridge(started);
		return;
	}
	if (state.closed) return;
	if (activeBridge === state) activeBridge = undefined;
	state.closing = true;
	state.shutdown.abort(new DOMException("OMP session ended", "AbortError"));
	for (const pending of Array.from(state.pending.values())) {
		if (pending.job.op !== "dispose") rejectPending(state, pending, new Error("OMP session ended"));
	}
	if (state.actionWaiter) {
		state.actionWaiter.reject(new Error("OMP session ended"));
		clearWaiter(state, state.actionWaiter);
	}
	const client = state.client;
	if (client && state.leaseExpiresAt > Date.now()) {
		const dispose = createPendingJob(state, { id: "", op: "dispose" }, "dispose", SHUTDOWN_DISPOSE_MS);
		await Promise.race([dispose.catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_DISPOSE_MS))]);
	}
	state.alive = false;
	state.closed = true;
	state.views.clear();
	state.hosts.clear();
	state.components.clear();
	state.updates.clear();
	state.tui?.requestRender();
	state.tui = undefined;
	if (state.widgetRegistered) state.ui.setWidget(state.widgetKey, undefined);
	await fs.rm(state.registrationPath, { force: true }).catch(() => {});
	state.server?.stop(true);
	for (const pending of Array.from(state.pending.values())) rejectPending(state, pending, new Error("OMP session ended"));
	if (state.poll) {
		clearTimeout(state.poll.timer);
		state.poll.abortSignal.removeEventListener("abort", state.poll.abortHandler);
		state.poll.resolve(httpError(410, "OMP session ended"));
		state.poll = undefined;
	}
}

function currentSnapshots(state: BridgeState, callId: string, snapshots: readonly ViewSnapshot[]): ViewSnapshot[] {
	if (state.alive && !state.closed) {
		const active = Array.from(state.views.values(), entry => entry.snapshot);
		const owned = active.filter(snapshot => snapshot.ownerCallId === callId);
		const displaced = snapshots.filter(snapshot => {
			const owner = state.views.get(snapshot.id)?.snapshot.ownerCallId;
			return owner !== undefined && owner !== callId;
		});
		return [...owned, ...displaced];
	}
	return snapshots.filter(snapshot => snapshot.ownerCallId === callId);
}

function componentFor(state: BridgeState, snapshot: ViewSnapshot): InlineViewComponent {
	if (state.views.get(snapshot.id)?.snapshot.ownerCallId !== snapshot.ownerCallId) {
		return new InlineViewComponent(state, snapshot);
	}
	let byView = state.components.get(snapshot.ownerCallId);
	if (!byView) {
		byView = new Map<string, InlineViewComponent>();
		state.components.set(snapshot.ownerCallId, byView);
	}
	let component = byView.get(snapshot.id);
	if (!component) {
		component = new InlineViewComponent(state, snapshot);
		byView.set(snapshot.id, component);
	}
	return component;
}

class InlineViewHost implements Component {
	readonly #state: BridgeState;
	readonly #bridgeId: string;
	readonly #callId: string;
	readonly #snapshots: readonly ViewSnapshot[];
	#lastRevision = -1;
	#node: NativeNode | undefined;

	constructor(state: BridgeState, bridgeId: string, callId: string, snapshots: readonly ViewSnapshot[]) {
		this.#state = state;
		this.#bridgeId = bridgeId;
		this.#callId = callId;
		this.#snapshots = snapshots;
	}

	render(_width: number): readonly string[] {
		return EMPTY_ROWS;
	}

	describe(): NativeNode {
		if (this.#node && this.#lastRevision === this.#state.revision) return this.#node;
		const ownsSession = this.#state.alive && !this.#state.closed && this.#state.id === this.#bridgeId;
		const snapshots = ownsSession
			? currentSnapshots(this.#state, this.#callId, this.#snapshots)
			: this.#snapshots.filter(snapshot => snapshot.ownerCallId === this.#callId);
		this.#node = col(snapshots.map(snapshot => componentFor(this.#state, snapshot)));
		this.#lastRevision = this.#state.revision;
		return this.#node;
	}
}

class InlineViewComponent implements Component {
	readonly #state: BridgeState;
	readonly #snapshot: ViewSnapshot;
	#lastSource: ViewSnapshot | undefined;
	#lastInteractive = false;
	#node: NativeNode | undefined;

	constructor(state: BridgeState, snapshot: ViewSnapshot) {
		this.#state = state;
		this.#snapshot = snapshot;
	}

	render(_width: number): readonly string[] {
		return EMPTY_ROWS;
	}

	describe(): NativeNode {
		const active = this.#state.alive && !this.#state.closed &&
			this.#state.views.get(this.#snapshot.id)?.snapshot.ownerCallId === this.#snapshot.ownerCallId;
		const source = active ? this.#state.views.get(this.#snapshot.id)?.snapshot ?? this.#snapshot : this.#snapshot;
		if (this.#node && this.#lastSource === source && this.#lastInteractive === active) return this.#node;
		const view = viewNode(source, active, `tern/${this.#snapshot.ownerCallId}/${this.#snapshot.id}`);
		this.#node = view;
		this.#lastSource = source;
		this.#lastInteractive = active;
		return this.#node;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const active = this.#state.alive && !this.#state.closed &&
			this.#state.views.get(this.#snapshot.id)?.snapshot.ownerCallId === this.#snapshot.ownerCallId;
		if (!active) return;
		void createPendingJob(
			this.#state,
			{ id: "", op: "action", view: this.#snapshot.id, event },
			this.#snapshot.ownerCallId,
			CALLBACK_TIMEOUT_MS,
			this.#state.shutdown.signal,
		).catch(error => {
			logger.warn(`Tern bridge action failed: ${errorMessage(error)}`);
		});
	}
}

class ReplayViewHost implements Component {
	readonly #snapshots: readonly ViewSnapshot[];

	constructor(snapshots: readonly ViewSnapshot[]) {
		this.#snapshots = snapshots;
	}

	render(_width: number): readonly string[] {
		return EMPTY_ROWS;
	}

	describe(): NativeNode {
		return col(this.#snapshots.map(snapshot =>
			viewNode(snapshot, false, `tern/replay/${snapshot.ownerCallId}/${snapshot.id}`)
		));
	}
}

/**
 * A snapshot's titled native node. Its stylesheet is registered under a content
 * hash, so identical CSS shares one sheet and replayed views keep their look on
 * any surface. Tern confines the sheet to omp's surface, not to the view: views
 * scope their own selectors.
 */
function viewNode(snapshot: ViewSnapshot, interactive: boolean, path: string): NativeNode {
	if (snapshot.css !== undefined) registerNativeStyle(`omp-tern-${Bun.hash(snapshot.css).toString(36)}`, snapshot.css);
	const view = toNativeNode(snapshot.view, interactive, path);
	return snapshot.title !== undefined ? col([text(snapshot.title, { role: "omp.tool.title" }), view]) : view;
}

function viewHost(state: BridgeState, details: ExecDetails): InlineViewHost {
	const key = details.callId;
	let host = state.hosts.get(key);
	if (!host) {
		host = new InlineViewHost(state, details.bridgeId, details.callId, details.views);
		state.hosts.set(key, host);
	}
	return host;
}

function textResult(details: ExecDetails | undefined, isError: boolean): NativeToolView {
	const body: NativeChild[] = [];
	if (details) {
		body.push(new ReplayViewHost(details.views));
		if (details.result !== undefined || details.action !== undefined) {
			const output = details.action !== undefined
				? { result: details.result ?? null, action: details.action }
				: details.result ?? null;
			body.push(text(JSON.stringify(output), { wrap: "word" }));
		}
		if (details.error) body.push(text(details.error, { role: "omp.tool.error" }));
	}
	if (body.length === 0) body.push(text(isError ? "Tern execution failed" : "No output"));
	return {
		tool: { title: "Tern", target: "Luau", targetKind: "command", lang: "lua" },
		body,
		tone: isError ? "error" : "neutral",
		inline: true,
		preview: "none",
	};
}

function toolError(message: string, details: ExecDetails): AgentToolResult<ExecDetails> {
	return { content: [{ type: "text", text: message }], details: { ...details, error: message }, isError: true };
}

export default async function ternBridgeExtension(pi: ExtensionAPI): Promise<void> {
	const prompt = toolPrompt.trim();
	const parameters = pi.zod.object({
		code: pi.zod.string().min(1).max(MAX_CODE_BYTES).describe("Luau source to run inside the current Tern window"),
		timeout: pi.zod.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional()
			.describe("Maximum seconds to wait for each bridge phase; defaults to 30, capped at 300"),
		waitForAction: pi.zod.boolean().optional()
			.describe("Wait for the first inline action emit and return it with the script value instead of sending that one event as an aside"),
	});

	pi.registerTool({
		name: "tern_exec",
		label: "Tern",
		description: prompt,
		approval: "exec",
		loadMode: "essential",
		parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ExecDetails>> {
			let state: BridgeState | undefined;
			let waiter: ActionWaiter | undefined;
			try {
				const timeoutMs = timeoutSeconds(params.timeout) * 1000;
				state = await ensureBridge(pi, ctx);
				if (params.waitForAction === true) {
					if (state.actionWaiter) {
						return toolError("Another tern_exec call is already waiting for an inline action in this Tern session.", detailsFor(state, toolCallId));
					}
					waiter = createActionWaiter(signal);
					state.actionWaiter = waiter;
				}
				state.activeCallId = toolCallId;
				if (onUpdate) state.updates.set(toolCallId, onUpdate);
				const pending = await createPendingJob(
					state,
					{ id: "", op: "exec", code: params.code },
					toolCallId,
					timeoutMs,
					signal,
					waiter,
					timeoutMs,
				);
				if (!pending.ok) {
					if (waiter) clearWaiter(state, waiter);
					return toolError(pending.error ?? "Tern script failed", { ...detailsFor(state, toolCallId), result: pending.value ?? null });
				}
				const resultValue = pending.value ?? null;
				if (waiter) {
					const action = await waiter.promise;
					const details: ExecDetails = { ...detailsFor(state, toolCallId), result: resultValue, action };
					const response: JsonObject = { result: resultValue, action };
					return { content: [{ type: "text", text: JSON.stringify(response) }], details };
				}
				const details: ExecDetails = { ...detailsFor(state, toolCallId), result: resultValue };
				return { content: [{ type: "text", text: JSON.stringify(resultValue) }], details };
			} catch (error) {
				const message = errorMessage(error);
				if (state && waiter) clearWaiter(state, waiter);
				return toolError(message, state ? detailsFor(state, toolCallId) : { bridgeId: "", callId: toolCallId, views: [] });
			} finally {
				if (state) state.updates.delete(toolCallId);
			}
		},
		describeCall: (args, options: ToolRenderResultOptions): NativeToolView => ({
			tool: { title: "Tern", target: "Luau", targetKind: "command", lang: "lua" },
			body: options.expanded ? [text(args.code.slice(0, 2_000), { wrap: "word" })] : [],
		}),
		describeResult: (result, _options: ToolRenderResultOptions): NativeToolView => {
			const details = result.details;
			if (!details) return textResult(undefined, result.isError === true);
			const state = activeBridge?.id === details.bridgeId && activeBridge.alive && !activeBridge.closed
				? activeBridge
				: undefined;
			if (!state) return textResult(details, result.isError === true);
			const body: NativeChild[] = [];
			const hasActiveViews = Array.from(state.views.values()).some(entry => entry.snapshot.ownerCallId === details.callId);
			if (hasActiveViews) body.push(viewHost(state, details));
			else if (details.views.length > 0) body.push(new InlineViewHost(state, details.bridgeId, details.callId, details.views));
			if (details.result !== undefined || details.action !== undefined) {
				const output = details.action !== undefined
					? { result: details.result ?? null, action: details.action }
					: details.result ?? null;
				body.push(text(JSON.stringify(output), { wrap: "word" }));
			}
			if (details.error) body.push(text(details.error, { role: "omp.tool.error" }));
			return {
				tool: { title: "Tern", target: "Luau", targetKind: "command", lang: "lua" },
				body,
				tone: result.isError ? "error" : "neutral",
				inline: true,
				preview: hasActiveViews ? { lines: 24 } : "none",
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		void ensureBridge(pi, ctx).catch(error => pi.logger.warn(`Tern bridge startup failed: ${errorMessage(error)}`));
	});
	pi.on("session_switch", (_event, ctx) => {
		void ensureBridge(pi, ctx).catch(error => pi.logger.warn(`Tern bridge restart failed: ${errorMessage(error)}`));
	});
	pi.on("session_branch", (_event, ctx) => {
		void ensureBridge(pi, ctx).catch(error => pi.logger.warn(`Tern bridge branch restart failed: ${errorMessage(error)}`));
	});
	pi.on("session_tree", (_event, ctx) => {
		void ensureBridge(pi, ctx).catch(error => pi.logger.warn(`Tern bridge tree restart failed: ${errorMessage(error)}`));
	});
	pi.on("session_shutdown", async () => stopBridge());
}
