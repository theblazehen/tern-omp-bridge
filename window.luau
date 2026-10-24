-- The bridge transports scripts and events; Tern owns the UI vocabulary.
local sessions = {}
local client = tostring(tern.now()) .. "-" .. tostring(math.random(1, 2147483647))
local runtime = tern.getenv("XDG_RUNTIME_DIR")
local home = tern.getenv("HOME")
local socket = tern.getenv("TERN_DAEMON_SOCKET")
-- Same rule as the extension: the runtime directory when set, else a private cache directory.
local directory = (runtime and runtime ~= "" and runtime .. "/omp-tern") or (home and home .. "/.cache/omp-tern")

-- A window started without TERN_DAEMON_SOCKET talks to the default daemon, whose socket is daemon.sock.
local function same_daemon(registered)
	if socket then return registered == socket end
	return type(registered) == "string" and string.sub(registered, -12) == "/daemon.sock"
end

local function request(s, route, body, callback)
	local options = {
		headers = { Authorization = "Bearer " .. s.registration.token },
		timeout_ms = 25000,
	}
	if body ~= nil then
		options.method = "POST"
		options.headers["Content-Type"] = "application/json"
		options.body = tern.json.encode(body)
	end
	tern.fetch(s.registration.url .. route, options, callback)
end

local function context(s)
	assert(s.alive, "The owning omp session has ended")
	assert(s.cx, "Use omp.with_context(cx, fn) inside an upstream async callback")
	return s.cx
end

local function flush(s)
	if #s.effects == 0 or s.batching then return end
	local effects = s.effects
	s.effects = tern.json.array()
	request(s, "/effects", { effects = effects }, function(result)
		if result.status ~= 200 then
			tern.log.warn("omp bridge: action delivery failed", result.error or result.status)
		end
	end)
end

local function effect(s, value)
	assert(s.alive, "The owning omp session has ended")
	-- Check while still in the script/callback, rather than losing a transport callback.
	tern.json.encode(value)
	table.insert(s.effects, value)
	flush(s)
end

local function scoped(s, cx, fn, ...)
	local previousCx, previousBatch = s.cx, s.batching
	s.cx, s.batching = cx, true
	local result = table.pack(pcall(fn, ...))
	s.cx, s.batching = previousCx, previousBatch
	flush(s)
	if not result[1] then error(result[2], 0) end
	return table.unpack(result, 2, result.n)
end

local function helpers(s)
	local omp = { session = { id = s.registration.id, pane = s.registration.pane } }
	function omp.view(id)
		local view = s.views[id]
		return view and (view.pane or id)
	end
	-- cx.canvas:get reads a replica that can miss a canvas this window just opened (seen from
	-- timer and fetch callbacks); the session's pane list is authoritative for "still open".
	local function canvas_open(cx, view)
		return view.pane ~= nil and cx.session:pane(view.pane) ~= nil
	end
	local function drop_sheet(view)
		-- tern.css has no removal; an empty sheet styles nothing.
		if view.sheet then tern.css(view.sheet, "") end
	end
	function omp.close(id)
		local cx = context(s)
		local view = s.views[id]
		if not view then return end
		if view.pane then
			if canvas_open(cx, view) then cx.layout:close(view.pane) end
			drop_sheet(view)
		else
			effect(s, { type = "close", id = id })
		end
		s.views[id], s.handlers[id] = nil, nil
	end
	function omp.show(id, spec)
		local cx = context(s)
		assert(type(id) == "string" and #id > 0 and #id <= 128, "A view needs a name (1–128 bytes)")
		assert(type(spec) == "table" and type(spec.view) == "table", "show requires an upstream view node")
		assert(spec.css == nil or type(spec.css) == "string", "css must be a string")
		local placement = spec.placement or "beside"
		assert(placement == "inline" or placement == "beside", "placement must be inline or beside")
		local view = s.views[id]
		if view and view.placement ~= placement then omp.close(id); view = nil end
		if placement == "inline" then
			-- omp installs the css as a stylesheet confined to its own surface.
			effect(s, { type = "show", id = id, view = spec.view, title = spec.title, css = spec.css })
			s.views[id] = { placement = placement }
			return id
		end
		-- Canvas sheets are app-wide: selectors must start at the view's own root class.
		local sheet = view and view.sheet
		if spec.css then
			if not sheet then
				s.sheet_count += 1
				sheet = "omp-" .. s.registration.id .. "-" .. s.sheet_count
			end
			tern.css(sheet, spec.css)
		end
		if view and canvas_open(cx, view) then
			cx.canvas:set(view.pane, { view = spec.view, dock = spec.dock, title = spec.title, about = spec.about })
			view.sheet = sheet
			if spec.focus then cx.layout:focus(view.pane) end
			return view.pane
		end
		assert(cx.session:pane(s.registration.pane), "The owning omp pane has closed")
		local pane, err = cx.canvas:open({
			title = spec.title or id,
			about = spec.about or ("omp " .. s.registration.id .. " / " .. id),
			view = spec.view, dock = spec.dock, how = "beside", focus = false,
		})
		assert(pane, err or "Tern could not open the canvas")
		if not cx.layout:move(pane, s.registration.pane, "right", { focus = spec.focus == true }) then
			cx.layout:close(pane)
			error("Tern could not dock beside the owning omp pane")
		end
		s.views[id] = { placement = placement, pane = pane, sheet = sheet }
		return pane
	end
	function omp.on_action(id, fn)
		assert(type(fn) == "function", "on_action requires a callback")
		s.handlers[id] = fn
	end
	function omp.emit(data)
		effect(s, { type = "emit", data = data == nil and tern.json.null or data })
	end
	function omp.with_context(cx, fn)
		return scoped(s, cx, fn)
	end
	return omp
end

local function dispatch(s, id, event, cx)
	return scoped(s, cx, function()
		local handler = s.handlers[id]
		if handler and handler(event, cx) == true then return end
		if event.act or event.type == "action" then
			s.omp.emit({ view = id, action = event.act, event = event })
		end
	end)
end

local function dispose(s, cx)
	if not s.alive then return end
	-- Only tracked canvases are ours; raw API-created panes remain the script's responsibility.
	scoped(s, cx, function()
		local ids = {}
		for id in s.views do table.insert(ids, id) end
		for _, id in ids do s.omp.close(id) end
	end)
	s.alive = false
	sessions[s.registration.id] = nil
end

local nextJob
nextJob = function(s)
	if not s.alive then return end
	request(s, "/next?client=" .. client, nil, function(result, cx)
		if not s.alive then return end
		if result.status == 204 then nextJob(s); return end
		if result.status ~= 200 then
			dispose(s, cx)
			return
		end
		local decoded, job = pcall(tern.json.decode, result.body)
		if not decoded or type(job) ~= "table" or type(job.id) ~= "string" then
			tern.log.error("omp bridge: invalid job", tostring(job))
			dispose(s, cx)
			return
		end
		s.batching, s.cx = true, cx
		local ok, value = pcall(function()
			if job.op == "exec" then
				local chunk, err = loadstring("return function(cx, omp)\n" .. job.code .. "\nend", "tern_exec")
				assert(chunk, err)
				return chunk()(cx, s.omp)
			elseif job.op == "action" then
				assert(s.views[job.view], "This inline view is no longer active")
				return dispatch(s, job.view, job.event, cx)
			elseif job.op == "dispose" then
				dispose(s, cx)
				return nil
			end
			error("Unknown bridge operation: " .. tostring(job.op))
		end)
		s.cx, s.batching = nil, false
		local response = { id = job.id, ok = ok, effects = s.effects }
		s.effects = tern.json.array()
		if ok then response.value = value == nil and tern.json.null or value
		else response.error = tostring(value) end
		local serializable, serializationError = pcall(tern.json.encode, response)
		if not serializable then
			response.value = nil
			response.ok, response.error = false, "Result is not JSON-serializable: " .. tostring(serializationError)
		end
		request(s, "/complete", response, function(completed, freshCx)
			if completed.status == 200 then nextJob(s)
			else dispose(s, freshCx) end
		end)
	end)
end

-- Only omp agents in this window may claim a bridge (Tern 0.4.4+ lists omp in any pane as an agent).
local function is_agent(cx, pane)
	for _, agent in cx.agents:list() do
		if agent.pane == pane then return true end
	end
	return false
end

local function discover(cx)
	if directory and tern.fs.exists(directory) then
		local listed, files = pcall(tern.fs.list, directory)
		if listed then
			for _, file in files do
				if string.sub(file, -5) ~= ".json" then continue end
				local valid, registration = pcall(function()
					return tern.json.decode(tern.fs.read(directory .. "/" .. file, 16384))
				end)
				if not valid or type(registration) ~= "table" or registration.version ~= 1 then continue end
				if type(registration.id) ~= "string" or type(registration.token) ~= "string" then continue end
				if type(registration.url) ~= "string" or not string.match(registration.url, "^http://127%.0%.0%.1:%d+$") then continue end
				if not same_daemon(registration.socket) or not is_agent(cx, registration.pane) then continue end
				if sessions[registration.id] then continue end
				local s = {
					registration = registration, alive = true, views = {}, handlers = {},
					effects = tern.json.array(), sheet_count = 0,
				}
				s.omp = helpers(s)
				sessions[registration.id] = s
				nextJob(s)
			end
		end
	end
	tern.timer(2000, discover)
end

local discovering = false
local function start(cx)
	if discovering then return end
	discovering = true
	discover(cx)
end
-- window_start receives only cx, and a window reload does not run it again for a plugin that
-- already ran it: the load-time timer restarts discovery in a reloaded VM.
tern.on("window_start", start)
tern.timer(0, start)
tern.on("canvas_action", function(event, cx)
	for _, s in sessions do
		for id, view in s.views do
			if view.pane == event.pane then
				local ok, err = pcall(dispatch, s, id, event, cx)
				if not ok then
					tern.log.error("omp bridge: action failed", tostring(err))
					s.omp.emit({ view = id, error = tostring(err) })
				end
				return true
			end
		end
	end
	return false
end)
