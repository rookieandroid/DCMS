const state = {
  token: "",
  auth: { role: "guest" },
  profile: null,
  players: [],
  events: [],
  auctions: [],
  inhouseSessions: [],
  selectedEventId: "",
  selectedAuctionId: "",
  selectedInhouseId: "",
  editingPlayerId: "",
  selectedCaptainIds: [],
  selectedPickPlayerId: "",
  feedback: "",
  error: "",
  auctionEvents: null,
  inhouseEvents: null,
  countdownTimer: null,
  currentPage: "hub",
  homePlayerFilters: {
    keyword: "",
    position: "",
    sort: "powerDesc"
  },
  adminPlayerFilters: {
    keyword: "",
    position: "",
    sort: "powerDesc"
  }
};

const app = document.querySelector("#app");

function setNotice(message = "", type = "info") {
  state.feedback = type === "error" ? "" : message;
  state.error = type === "error" ? message : "";
}

function formatDate(value) {
  if (!value) {
    return "未设置";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function getHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  return headers;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...getHeaders(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

function saveSession() {
  if (state.token) {
    localStorage.setItem("dcms-token", state.token);
  } else {
    localStorage.removeItem("dcms-token");
  }
  localStorage.setItem("dcms-page", state.currentPage);
}

function closeStreams() {
  if (state.auctionEvents) {
    state.auctionEvents.close();
    state.auctionEvents = null;
  }
  if (state.inhouseEvents) {
    state.inhouseEvents.close();
    state.inhouseEvents = null;
  }
}

function hydrate(bootstrap) {
  state.auth = bootstrap.auth || { role: "guest" };
  state.profile = bootstrap.profile || null;
  state.players = bootstrap.players || [];
  state.events = bootstrap.events || [];
  state.auctions = bootstrap.auctions || [];
  state.inhouseSessions = bootstrap.inhouseSessions || [];

  if (!state.selectedEventId || !state.events.some((event) => event.id === state.selectedEventId)) {
    state.selectedEventId = state.events[0]?.id || "";
  }
  if (!state.selectedAuctionId || !state.auctions.some((auction) => auction.id === state.selectedAuctionId)) {
    state.selectedAuctionId = state.auctions[0]?.id || "";
  }
  if (
    !state.selectedInhouseId ||
    !state.inhouseSessions.some((session) => session.id === state.selectedInhouseId)
  ) {
    state.selectedInhouseId =
      state.inhouseSessions.find((session) => session.eventId === state.selectedEventId)?.id ||
      state.inhouseSessions[0]?.id ||
      "";
  }

  const activeSession = getCurrentInhouse();
  if (activeSession && !activeSession.availablePlayers.some((player) => player.id === state.selectedPickPlayerId)) {
    state.selectedPickPlayerId = activeSession.availablePlayers[0]?.id || "";
  }
}

function setPage(page) {
  state.currentPage = page;
  localStorage.setItem("dcms-page", page);
}

async function refreshBootstrap() {
  const bootstrap = await api("/api/bootstrap", { method: "GET" });
  hydrate(bootstrap);
  connectStreams();
  render();
}

function getCurrentEvent() {
  return state.events.find((event) => event.id === state.selectedEventId) || null;
}

function getCurrentAuction() {
  return state.auctions.find((auction) => auction.id === state.selectedAuctionId) || null;
}

function getCurrentInhouse() {
  return state.inhouseSessions.find((session) => session.id === state.selectedInhouseId) || null;
}

function getPlayer(id) {
  return state.players.find((player) => player.id === id) || null;
}

function filterPlayers(players, filters) {
  const keyword = String(filters.keyword || "").trim().toLowerCase();
  const position = String(filters.position || "").trim();
  const sort = filters.sort === "powerAsc" ? "powerAsc" : "powerDesc";

  return [...players]
    .filter((player) => {
      if (!keyword) {
        return true;
      }
      return [player.id, player.displayName, player.wechatName, player.intro]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    })
    .filter((player) => !position || player.positions.includes(position))
    .sort((a, b) => {
      if (sort === "powerAsc") {
        return a.power - b.power || String(a.id).localeCompare(String(b.id));
      }
      return b.power - a.power || String(a.id).localeCompare(String(b.id));
    });
}

function getEventAuction(eventId) {
  return state.auctions.find((auction) => auction.eventId === eventId) || null;
}

function getEventPhaseMeta(event) {
  const auction = getEventAuction(event.id);
  if (auction?.status === "running") {
    return { label: "拍卖中", tone: "phase-live", detail: "队长正在对剩余选手竞价" };
  }
  if (auction?.status === "paused") {
    return { label: "拍卖暂停", tone: "phase-warning", detail: "管理员已暂停当前倒计时" };
  }
  if (event.inhouseStatus === "drafting") {
    return { label: "选人中", tone: "phase-info", detail: "队长正在按当前轮次选人" };
  }
  if (event.signupOpen) {
    return { label: "报名开放中", tone: "phase-live", detail: "玩家可以直接在首页完成报名" };
  }
  if (event.captainIds.length) {
    return { label: "等待后续流程", tone: "phase-info", detail: "已任命队长，等待拍卖或选人继续" };
  }
  return { label: "报名已关闭", tone: "phase-muted", detail: "当前赛事暂未开放或已结束报名" };
}

function getDashboardStats() {
  const openEvents = state.events.filter((event) => event.signupOpen).length;
  const draftingEvents = state.events.filter((event) => event.inhouseStatus === "drafting").length;
  const runningAuctions = state.auctions.filter((auction) => auction.status === "running").length;
  return {
    totalPlayers: state.players.length,
    totalEvents: state.events.length,
    openEvents,
    draftingEvents,
    runningAuctions
  };
}

function renderMetricCards(metrics) {
  return `
    <section class="metric-grid">
      ${metrics
        .map(
          (metric) => `
            <article class="glass metric-card">
              <span>${metric.label}</span>
              <strong>${metric.value}</strong>
              <small>${metric.caption}</small>
            </article>
          `
        )
        .join("")}
    </section>
  `;
}

function renderPlayerDirectory(filters, players, options = {}) {
  const title = options.title || "玩家库";
  const subtitle = options.subtitle || "按战力、位置和关键词快速筛选";
  const keywordId = options.keywordId || "directory-keyword";
  const positionId = options.positionId || "directory-position";
  const sortId = options.sortId || "directory-sort";
  const emptyText = options.emptyText || "暂时没有符合条件的玩家。";

  return `
    <section class="glass directory-shell">
      <div class="card-head">
        <div>
          <h2>${title}</h2>
          <span>${subtitle}</span>
        </div>
        <span>${players.length} 名玩家</span>
      </div>
      <div class="toolbar-grid">
        <label>关键词
          <input id="${keywordId}" type="text" value="${filters.keyword}" placeholder="昵称、数字 ID、微信名" />
        </label>
        <label>位置
          <select id="${positionId}">
            <option value="">全部位置</option>
            ${["1", "2", "3", "4", "5"].map((position) => `<option value="${position}" ${filters.position === position ? "selected" : ""}>${position} 号位</option>`).join("")}
          </select>
        </label>
        <label>排序
          <select id="${sortId}">
            <option value="powerDesc" ${filters.sort === "powerDesc" ? "selected" : ""}>战力从高到低</option>
            <option value="powerAsc" ${filters.sort === "powerAsc" ? "selected" : ""}>战力从低到高</option>
          </select>
        </label>
      </div>
      <div class="directory-list">
        ${
          players.length
            ? players
                .map(
                  (player) => `
                    <article class="directory-card">
                      <div class="directory-card-head">
                        <div class="mini-avatar">${player.displayName.slice(0, 1)}</div>
                        <div>
                          <strong>${player.displayName}</strong>
                          <p>ID ${player.id} · 战力 ${player.power} · 分数 ${player.mmr}</p>
                        </div>
                      </div>
                      <div class="hero-tags compact-tags">
                        ${(player.positions || []).map((position) => `<span class="tag">位置 ${position}</span>`).join("")}
                      </div>
                      <p class="directory-intro">${player.intro || "这个玩家还没有填写个人简介。"}</p>
                    </article>
                  `
                )
                .join("")
            : `<p class="muted-line">${emptyText}</p>`
        }
      </div>
    </section>
  `;
}

function isAdmin() {
  return state.auth.role === "admin";
}

function isPlayer() {
  return state.auth.role === "player";
}

function isEventCaptain(event, playerId) {
  return Boolean(event && playerId && event.captainIds.includes(playerId));
}

function getAuctionCountdown(auction) {
  if (auction?.status === "paused") {
    return "已暂停";
  }
  if (!auction?.currentLot?.expiresAt) {
    return "0 s";
  }
  const diff = Math.max(0, Math.ceil((new Date(auction.currentLot.expiresAt).getTime() - Date.now()) / 1000));
  return `${diff} s`;
}

function connectStreams() {
  closeStreams();
  const auction = getCurrentAuction();
  if (auction) {
    state.auctionEvents = new EventSource(
      `/api/auctions/${auction.id}/events?token=${encodeURIComponent(state.token || "")}`
    );
    state.auctionEvents.addEventListener("auction.updated", (event) => {
      const next = JSON.parse(event.data);
      state.auctions = state.auctions.map((item) => (item.id === next.id ? next : item));
      render();
    });
  }

  const session = getCurrentInhouse();
  if (session) {
    state.inhouseEvents = new EventSource(
      `/api/inhouse/${session.id}/events?token=${encodeURIComponent(state.token || "")}`
    );
    state.inhouseEvents.addEventListener("inhouse.updated", (event) => {
      const next = JSON.parse(event.data);
      state.inhouseSessions = state.inhouseSessions.map((item) => (item.id === next.id ? next : item));
      render();
    });
    state.inhouseEvents.addEventListener("event.updated", (event) => {
      const next = JSON.parse(event.data);
      state.events = state.events.map((item) => (item.id === next.id ? next : item));
      render();
    });
  }
}

function playerCard(player, extra = "") {
  return `
    <article class="mini-player-card">
      <div class="mini-avatar">${player.displayName.slice(0, 1)}</div>
      <div class="mini-player-main">
        <strong>${player.displayName}</strong>
        <span>ID ${player.id} · 战力 ${player.power}</span>
        ${extra}
      </div>
    </article>
  `;
}

function renderAuthPanel() {
  const profile = state.profile;
  return `
    <section class="top-shell">
      <div class="brand-panel glass">
        <p class="eyebrow">DOTA2 Community Match System</p>
        <h1>刀塔社区赛综合管理系统</h1>
        <p class="subcopy">用一个轻量 MVP 同时打通玩家库、数字 ID 登录、内战报名和选手拍卖大厅。</p>
      </div>
      <div class="auth-panel glass">
        ${
          state.auth.role === "guest"
            ? `
            <div class="auth-grid">
              <form id="admin-login-form" class="stack">
                <h3>管理员登录</h3>
                <label>口令<input type="password" name="password" placeholder="请输入管理员口令" required /></label>
                <button type="submit">进入后台</button>
              </form>
              <form id="player-login-form" class="stack">
                <h3>玩家数字 ID 登录</h3>
                <label>数字 ID<input type="text" name="playerId" placeholder="例如 1001" required /></label>
                <button type="submit">进入前台</button>
              </form>
            </div>
          `
            : `
            <div class="session-head">
              <div>
                <p class="session-role">${state.auth.role === "admin" ? "后台管理员" : "玩家登录中"}</p>
                <strong>${profile?.displayName || "管理员控制台"}</strong>
                <span>${profile ? `数字 ID ${profile.id}` : "拥有玩家库、赛事和拍卖配置权限"}</span>
              </div>
              <button id="logout-button" class="secondary-button">退出登录</button>
            </div>
          `
        }
        ${
          state.feedback
            ? `<div class="notice success">${state.feedback}</div>`
            : state.error
              ? `<div class="notice error">${state.error}</div>`
              : ""
        }
      </div>
    </section>
  `;
}

function renderPageNav() {
  return `
    <nav class="page-nav glass">
      <button class="${state.currentPage === "hub" ? "nav-active" : "secondary-button"}" data-page="hub">首页</button>
      <button class="${state.currentPage === "auction" ? "nav-active" : "secondary-button"}" data-page="auction">选手拍卖页</button>
      <button class="${state.currentPage === "inhouse" ? "nav-active" : "secondary-button"}" data-page="inhouse">内战选人页</button>
    </nav>
  `;
}

function renderPlayerHome() {
  const spotlightEvent = state.events[0] || null;
  const filteredPlayers = filterPlayers(state.players, state.homePlayerFilters);
  const stats = getDashboardStats();
  const spotlightMeta = spotlightEvent ? getEventPhaseMeta(spotlightEvent) : null;
  return `
    <section class="player-home">
      ${renderAuthPanel()}
      ${renderMetricCards([
        { label: "当前赛事", value: stats.totalEvents, caption: "首页统一查看所有赛事进度" },
        { label: "开放报名", value: stats.openEvents, caption: "开放中赛事会有动态状态提示" },
        { label: "选人进行中", value: stats.draftingEvents, caption: "队长轮次会同步到内战页" },
        { label: "玩家库", value: stats.totalPlayers, caption: "玩家资料可按战力和位置筛选" }
      ])}
      ${
        spotlightEvent
          ? `
            <section class="glass spotlight-shell">
              <div class="spotlight-main">
                <p class="eyebrow">Event Spotlight</p>
                <h2>${spotlightEvent.name}</h2>
                <p class="subcopy">${spotlightMeta.detail} · 开始时间 ${formatDate(spotlightEvent.startTime)}</p>
                <div class="hero-tags">
                  <span class="tag ${spotlightMeta.tone}">${spotlightMeta.label}</span>
                  <span class="tag">已报名 ${spotlightEvent.signupCount}</span>
                  <span class="tag">队长 ${spotlightEvent.captainIds.length}</span>
                </div>
              </div>
              <div class="spotlight-side">
                <span>当前最适合操作</span>
                <strong>${
                  state.auth.role === "player"
                    ? spotlightEvent.signedUp
                      ? "你已在该赛事名单中，可在首页取消报名"
                      : spotlightEvent.signupOpen
                        ? "可直接在首页完成报名"
                        : "等待管理员重新开放报名"
                    : "先登录玩家账号参与报名，或用管理员账号推进赛事"
                }</strong>
              </div>
            </section>
          `
          : ""
      }
      <section class="glass player-event-shell">
        <div class="card-head">
          <div>
            <h2>当前可报名赛事</h2>
            <span>登录后可以直接在首页报名或取消报名某个赛事</span>
          </div>
          <span>${state.events.length} 场赛事</span>
        </div>
        <div class="player-event-list">
          ${state.events
            .map(
              (event) => `
                <article class="player-event-card">
                  <div>
                    <strong>${event.name}</strong>
                    <p>开始时间：${formatDate(event.startTime)}</p>
                    <p>赛事阶段：<span class="status-badge ${getEventPhaseMeta(event).tone}">${getEventPhaseMeta(event).label}</span></p>
                    <p>报名状态：<span class="${event.signupOpen ? "status-live" : "status-closed"}">${event.signupOpen ? "开放中" : "已关闭"}</span> · 已报名 ${event.signupCount} 人 · 队长 ${event.captainIds.length} 人</p>
                  </div>
                  <div class="row-actions">
                    <button data-player-signup="${event.id}" class="success-button" ${event.signupOpen && !event.signedUp ? "" : "disabled"}>报名</button>
                    <button data-player-cancel="${event.id}" class="danger-button" ${event.signedUp ? "" : "disabled"}>取消报名</button>
                  </div>
                </article>
              `
            )
            .join("")}
        </div>
      </section>
      ${renderPlayerDirectory(state.homePlayerFilters, filteredPlayers, {
        title: "公开玩家库",
        subtitle: "让参赛者先看清当前社区里有哪些人、擅长什么位置",
        keywordId: "home-player-keyword",
        positionId: "home-player-position",
        sortId: "home-player-sort",
        emptyText: "没有符合当前筛选条件的公开玩家。"
      })}
    </section>
  `;
}

function renderAdminWorkspace() {
  const event = getCurrentEvent();
  const auction = getCurrentAuction();
  const eventPlayers = event ? state.players.filter((player) => event.signupIds?.includes(player.id)) : [];
  const filteredPlayers = filterPlayers(state.players, state.adminPlayerFilters);
  const selectedPlayer = state.players.find((player) => player.id === state.editingPlayerId) || null;
  const stats = getDashboardStats();
  const availableSignupPlayers = event
    ? state.players.filter((player) => !event.signupIds?.includes(player.id))
    : state.players;
  return `
    ${renderMetricCards([
      { label: "玩家总数", value: stats.totalPlayers, caption: "玩家库随时支持新增、编辑、筛选" },
      { label: "赛事总数", value: stats.totalEvents, caption: "可以删除、关闭报名、重建流程" },
      { label: "报名开放中", value: stats.openEvents, caption: "还允许继续报名的赛事数量" },
      { label: "拍卖进行中", value: stats.runningAuctions, caption: "需要主持人关注倒计时的拍卖" }
    ])}
    <section class="workspace-grid">
      <div class="glass admin-card">
        <div class="card-head">
          <h2>玩家库管理</h2>
          <span>${filteredPlayers.length}/${state.players.length} 名玩家</span>
        </div>
        <div class="toolbar-grid">
          <label>关键词
            <input id="admin-player-keyword" type="text" value="${state.adminPlayerFilters.keyword}" placeholder="搜索昵称、数字 ID、微信名" />
          </label>
          <label>位置
            <select id="admin-player-position">
              <option value="">全部位置</option>
              ${["1", "2", "3", "4", "5"].map((position) => `<option value="${position}" ${state.adminPlayerFilters.position === position ? "selected" : ""}>${position} 号位</option>`).join("")}
            </select>
          </label>
          <label>排序
            <select id="admin-player-sort">
              <option value="powerDesc" ${state.adminPlayerFilters.sort === "powerDesc" ? "selected" : ""}>战力从高到低</option>
              <option value="powerAsc" ${state.adminPlayerFilters.sort === "powerAsc" ? "selected" : ""}>战力从低到高</option>
            </select>
          </label>
        </div>
        <form id="player-form" class="grid-form">
          <input type="hidden" name="currentId" value="${selectedPlayer?.id || ""}" />
          <label>数字 ID<input name="id" value="${selectedPlayer?.id || ""}" ${selectedPlayer ? "disabled" : ""} required /></label>
          <label>游戏昵称<input name="displayName" value="${selectedPlayer?.displayName || ""}" required /></label>
          <label>微信昵称<input name="wechatName" value="${selectedPlayer?.wechatName || ""}" /></label>
          <label>分数<input name="mmr" type="number" value="${selectedPlayer?.mmr || 0}" /></label>
          <label>战力值<input name="power" type="number" min="0" max="100" value="${selectedPlayer?.power || 70}" required /></label>
          <label>擅长位置<input name="positions" value="${selectedPlayer?.positions?.join(",") || ""}" placeholder="1,2,5" /></label>
          <label class="full">自我介绍<textarea name="intro" rows="2">${selectedPlayer?.intro || ""}</textarea></label>
          <div class="form-actions full">
            <button type="submit">${selectedPlayer ? "保存修改" : "新增玩家"}</button>
            ${selectedPlayer ? `<button type="button" id="cancel-edit-player" class="secondary-button">取消编辑</button>` : ""}
          </div>
        </form>
        <div class="table-list">
          ${filteredPlayers
            .map(
              (player) => `
                <div class="table-row">
                  <div>
                    <strong>${player.displayName}</strong>
                    <span>ID ${player.id} · 战力 ${player.power} · 位置 ${player.positions.join("/") || "-"}</span>
                  </div>
                  <div class="row-actions">
                    <button type="button" data-edit-player="${player.id}" class="secondary-button small">编辑</button>
                    <button type="button" data-delete-player="${player.id}" class="ghost-button small">删除</button>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      </div>

      <div class="glass admin-card">
        <div class="card-head">
          <h2>赛事与报名管理</h2>
          <span>${state.events.length} 场赛事</span>
        </div>
        <form id="event-form" class="grid-form compact">
          <label>赛事名称<input name="name" required /></label>
          <label>开始时间<input name="startTime" type="datetime-local" /></label>
          <label>每队人数<input name="teamSize" type="number" min="2" value="5" /></label>
          <div class="form-actions full"><button type="submit">创建赛事</button></div>
        </form>
        ${
          event
            ? `
            <div class="selection-bar">
              <label>当前赛事
                <select id="event-switcher">
                  ${state.events.map((item) => `<option value="${item.id}" ${item.id === event.id ? "selected" : ""}>${item.name}</option>`).join("")}
                </select>
              </label>
              <div class="row-actions">
                <button type="button" id="toggle-event-signup-button" class="${event.signupOpen ? "warning-button" : "success-button"}">${event.signupOpen ? "关闭报名" : "开启报名"}</button>
                <button type="button" id="delete-event-button" class="ghost-button">删除赛事</button>
              </div>
            </div>
            <div class="event-overview-list">
              ${state.events
                .map((item) => {
                  const meta = getEventPhaseMeta(item);
                  return `
                    <button type="button" class="event-overview-card ${item.id === event.id ? "selected-overview" : ""}" data-select-event="${item.id}">
                      <strong>${item.name}</strong>
                      <span>${meta.label} · 报名 ${item.signupCount}</span>
                    </button>
                  `;
                })
                .join("")}
            </div>
            <div class="event-summary">
              <div><strong>${event.signupCount}</strong><span>已报名</span></div>
              <div><strong>${event.captainIds.length}</strong><span>已任命队长</span></div>
              <div><strong>${event.teamSize}</strong><span>每队人数</span></div>
            </div>
            <div class="checkbox-grid">
              ${eventPlayers
                .map((player) => {
                  const checked = state.selectedCaptainIds.includes(player.id) || event.captainIds.includes(player.id);
                  return `
                    <label class="check-card">
                      <input type="checkbox" data-captain-checkbox value="${player.id}" ${checked ? "checked" : ""} />
                      <span>${player.displayName}</span>
                      <small>ID ${player.id} · 战力 ${player.power}</small>
                    </label>
                  `;
                })
                .join("") || `<p class="muted-line">当前赛事还没有报名玩家。</p>`}
            </div>
            <div class="form-actions top-space">
              <button type="button" id="assign-captains-button">任命队长并初始化赛事</button>
            </div>
            <div class="selection-bar top-space">
              <label>管理员代报名到当前赛事
                <select id="admin-signup-player">
                  ${availableSignupPlayers.length ? availableSignupPlayers.map((player) => `<option value="${player.id}">${player.displayName} (${player.id})</option>`).join("") : '<option value="">当前所有玩家都已在该赛事中</option>'}
                </select>
              </label>
              <button type="button" id="admin-signup-button" ${availableSignupPlayers.length ? "" : "disabled"}>代报名</button>
            </div>
          `
            : `<p class="muted-line">先创建一个赛事，再进行报名和队长任命。</p>`
        }
      </div>

      <div class="glass admin-card">
        <div class="card-head">
          <h2>拍卖配置管理</h2>
          <span>${state.auctions.length} 个拍卖</span>
        </div>
        <form id="auction-form" class="grid-form compact">
          <label>关联赛事
            <select name="eventId">${state.events.map((item) => `<option value="${item.id}" ${item.id === state.selectedEventId ? "selected" : ""}>${item.name}</option>`).join("")}</select>
          </label>
          <label>标题<input name="title" placeholder="微雨杯 S1 社区赛选手拍卖" /></label>
          <label>起拍价<input name="startPrice" type="number" value="20" /></label>
          <label>加价幅度<input name="increment" type="number" value="10" /></label>
          <label>倒计时(秒)<input name="bidTimeoutSec" type="number" value="20" /></label>
          ${
            event?.captainIds?.length
              ? `<div class="full budget-assignment">
                  <div class="section-title slim">
                    <h4>队长预算分配</h4>
                    <span>按当前赛事已任命队长单独设置</span>
                  </div>
                  <div class="budget-grid">
                    ${event.captains
                      .map(
                        (captain) => `
                          <label>
                            ${captain.displayName}
                            <input name="budget_${captain.id}" type="number" value="600" min="0" />
                          </label>
                        `
                      )
                      .join("")}
                  </div>
                </div>`
              : `<p class="full muted-line">请先在当前赛事里任命队长，再为每位队长分配拍卖预算。</p>`
          }
          <div class="form-actions full"><button type="submit">创建拍卖</button></div>
        </form>
        ${
          event
            ? `
              <div class="auction-readiness">
                <div class="price-box">
                  <span>当前赛事阶段</span>
                  <strong>${getEventPhaseMeta(event).label}</strong>
                </div>
                <div class="price-box">
                  <span>已任命队长</span>
                  <strong>${event.captainIds.length}</strong>
                </div>
                <div class="price-box">
                  <span>报名人数</span>
                  <strong>${event.signupCount}</strong>
                </div>
              </div>
            `
            : ""
        }
        ${
          auction
            ? `
            <div class="selection-bar">
              <label>当前拍卖
                <select id="auction-switcher">
                  ${state.auctions.map((item) => `<option value="${item.id}" ${item.id === auction.id ? "selected" : ""}>${item.title}</option>`).join("")}
                </select>
              </label>
              ${
                auction.status === "pending"
                  ? `<button id="start-auction-button" type="button" class="action-button">启动拍卖</button>`
                  : auction.status === "paused"
                    ? `<button id="resume-auction-button" type="button" class="success-button">继续拍卖</button>`
                    : `<span class="status-pill">${auction.status === "running" ? "竞价进行中" : "拍卖已结束"}</span>`
              }
            </div>
          `
            : `<p class="muted-line">先创建拍卖，拍卖大厅才会进入可操作状态。</p>`
        }
      </div>
    </section>
  `;
}

function renderAuctionHall() {
  const auction = getCurrentAuction();
  if (!auction) {
    return `
      <section class="glass auction-shell empty-state">
        <h2>拍卖大厅</h2>
        <p>当前还没有可展示的拍卖。</p>
      </section>
    `;
  }

  const currentPlayer = auction.currentPlayer;
  const myTeam = auction.teams.find((team) => team.id === auction.myTeamId) || null;
  const soldCount = auction.completedLots.filter((lot) => lot.status === "sold").length;
  const unsoldCount = auction.unsoldPlayers.length;
  const nextBidAmount = auction.currentLot
    ? auction.currentLot.leadingTeamId
      ? auction.currentLot.currentPrice + auction.config.increment
      : Math.max(auction.currentLot.currentPrice, auction.config.startPrice)
    : auction.config.startPrice;

  return `
    <section class="auction-shell">
      <div class="auction-topbar glass">
        <div>
          <p class="eyebrow">Auction Hall</p>
          <h2>${auction.title}</h2>
        </div>
        <div class="topbar-meta">
          <span class="pill">状态 ${auction.status === "pending" ? "待开始" : auction.status === "running" ? "拍卖中" : "已结束"}</span>
          <span class="pill">已拍卖 ${soldCount}</span>
          <span class="pill">流拍 ${unsoldCount}</span>
          ${
            isAdmin() && auction.status === "running"
              ? `<button id="pause-auction-button" type="button" class="warning-button">暂停拍卖</button>`
              : ""
          }
          ${
            isAdmin() && auction.status === "paused"
              ? `<button id="resume-auction-inline-button" type="button" class="success-button">继续拍卖</button>`
              : ""
          }
        </div>
      </div>

      <div class="auction-board">
        <aside class="glass side-panel left-panel">
          <div class="section-title">
            <h3>队伍情况</h3>
            <span>预算与战力同步更新</span>
          </div>
          <div class="team-stack">
            ${auction.teams
              .map(
                (team) => `
                  <article class="team-card ${auction.currentLot?.leadingTeamId === team.id ? "highlight" : ""}">
                    <div class="team-card-head">
                      <div>
                        <strong>${team.name}</strong>
                        <span>队长 ${team.captain.displayName}</span>
                      </div>
                      <span class="budget-chip">${team.remainingBudget}/${team.budget}</span>
                    </div>
                    <div class="team-stat-row">
                      <span>总战力 ${team.totalPower}</span>
                      <span>已拍 ${team.players.length - 1}</span>
                    </div>
                    <div class="roster-list">
                      ${team.players.map((player) => playerCard(player)).join("")}
                    </div>
                  </article>
                `
              )
              .join("")}
          </div>
        </aside>

        <section class="glass center-stage">
          <div class="stage-header">
            <p class="stage-kicker">当前拍品</p>
            <h3>${currentPlayer ? currentPlayer.displayName : "等待开始拍卖"}</h3>
          </div>
          <div class="hero-player-card">
            <div class="hero-avatar">${currentPlayer ? currentPlayer.displayName.slice(0, 1) : "?"}</div>
            <div class="hero-meta">
              <strong>${currentPlayer ? currentPlayer.displayName : "暂无拍品"}</strong>
              <div class="hero-tags">
                <span class="tag">战力 ${currentPlayer?.power ?? "-"}</span>
                <span class="tag">分数 ${currentPlayer?.mmr ?? "-"}</span>
                <span class="tag">位置 ${currentPlayer?.positions?.join(" / ") || "-"}</span>
              </div>
              <p>${currentPlayer?.intro || "拍卖开始后会显示选手资料、自我介绍与实时竞价信息。"}</p>
            </div>
          </div>
          <div class="auction-core">
            <div class="price-box">
              <span>当前出价</span>
              <strong>${auction.currentLot ? auction.currentLot.currentPrice : auction.config.startPrice}</strong>
            </div>
            <div class="price-box">
              <span>当前领先</span>
              <strong>${auction.currentLot?.leadingTeamName || "暂无"}</strong>
            </div>
            <div class="price-box warning">
              <span>${auction.status === "paused" ? "倒计时" : "倒计时"}</span>
              <strong data-auction-countdown>${getAuctionCountdown(auction)}</strong>
            </div>
          </div>
          <div class="bid-panel">
            <form id="bid-form" class="bid-form">
              <button type="button" class="ghost-button" id="decrease-bid">- ${auction.config.increment}</button>
              <input name="amount" type="number" value="${nextBidAmount}" min="${nextBidAmount}" />
              <button type="button" class="ghost-button" id="increase-bid">+ ${auction.config.increment}</button>
              <button type="submit" class="action-button" ${auction.canBid ? "" : "disabled"}>我要出价</button>
            </form>
            <p class="helper-line">
              ${myTeam ? `你当前代表 ${myTeam.name} 竞价，剩余预算 ${myTeam.remainingBudget}。` : "登录为队长后可以在这里参与竞价。"}
            </p>
          </div>
          <div class="history-strip">
            ${
              auction.currentLot?.bids?.length
                ? auction.currentLot.bids
                    .slice(-5)
                    .reverse()
                    .map((bid) => `<span>${bid.amount} · ${auction.teams.find((team) => team.id === bid.teamId)?.name || ""}</span>`)
                    .join("")
                : "<span>当前拍品还没有出价记录</span>"
            }
          </div>
        </section>

        <aside class="glass side-panel right-panel">
          <div class="section-title">
            <h3>未拍卖选手列表</h3>
            <span>即将进入下一轮竞价</span>
          </div>
          <div class="queue-list">
            ${auction.upcomingPlayers.map((player) => playerCard(player)).join("") || `<p class="muted-line">队列已经结束。</p>`}
          </div>
          <div class="section-title slim">
            <h4>流拍选手</h4>
          </div>
          <div class="queue-list slim-list">
            ${auction.unsoldPlayers.map((player) => playerCard(player)).join("") || `<p class="muted-line">暂无流拍。</p>`}
          </div>
        </aside>
      </div>
    </section>
  `;
}

function renderInhouseBoard() {
  const event = getCurrentEvent();
  const session = getCurrentInhouse();
  if (!event) {
    return "";
  }
  const canSignup = isPlayer();
  const isCaptain = isEventCaptain(event, state.auth.playerId);
  const currentTeam = session?.teams.find((team) => team.id === session.currentTurnTeamId) || null;
  const availablePlayers = session?.availablePlayers || [];
  return `
    <section class="glass inhouse-shell">
      <div class="card-head">
        <div>
          <h2>内战报名与选人</h2>
          <span>${event.name}</span>
        </div>
        <div class="topbar-meta">
          <span class="pill">已报名 ${event.signupCount}</span>
          <span class="pill">${session ? `状态 ${session.status === "drafting" ? "选人中" : "已完成"}` : "待初始化"}</span>
        </div>
      </div>
      <div class="selection-bar">
        <label>当前赛事
          <select id="inhouse-event-switcher">
            ${state.events.map((item) => `<option value="${item.id}" ${item.id === event.id ? "selected" : ""}>${item.name}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="inhouse-grid">
        <div class="signup-panel">
          <h3>报名面板</h3>
          <p class="muted-line">玩家可以通过数字 ID 直接报名，管理员从报名名单里任命队长。</p>
          <div class="signup-actions">
            <button id="signup-button" class="success-button" ${canSignup && !event.signedUp ? "" : "disabled"}>报名今日内战</button>
            <button id="cancel-signup-button" class="danger-button" ${canSignup && event.signedUp ? "" : "disabled"}>取消报名</button>
          </div>
          <div class="queue-list">
            ${state.players
              .filter((player) => event.signupIds?.includes(player.id))
              .map((player) => playerCard(player))
              .join("") || `<p class="muted-line">目前还没有报名玩家。</p>`}
          </div>
        </div>
        <div class="pick-panel">
          <h3>队长选人</h3>
          <p class="muted-line">${currentTeam ? `当前轮到 ${currentTeam.name} 选择队员。` : "等待初始化或本轮已结束。"}</p>
          <div class="queue-list">
            ${availablePlayers
              .map(
                (player) => `
                  <label class="pick-option ${state.selectedPickPlayerId === player.id ? "selected" : ""}">
                    <input type="radio" name="pickPlayer" value="${player.id}" ${state.selectedPickPlayerId === player.id ? "checked" : ""} />
                    <span>${player.displayName}</span>
                    <small>战力 ${player.power} · 位置 ${player.positions.join("/") || "-"}</small>
                  </label>
                `
              )
              .join("") || `<p class="muted-line">当前没有可选玩家。</p>`}
          </div>
          <button id="pick-player-button" ${session && isCaptain && currentTeam?.captainId === state.auth.playerId && state.selectedPickPlayerId ? "" : "disabled"}>确认选择队员</button>
          <div class="history-list compact-history">
            ${(session?.pickHistory || [])
              .slice()
              .reverse()
              .map((item) => `<div class="history-row">第 ${item.round} 轮 · ${item.captain.displayName} 选择 ${item.player.displayName}</div>`)
              .join("") || `<p class="muted-line">还没有选人记录。</p>`}
          </div>
        </div>
        <div class="teams-panel">
          <h3>队伍与战力值</h3>
          ${
            session
              ? `
              <div class="team-stack compact-stack">
                ${session.teams
                  .map(
                    (team) => `
                      <article class="team-card ${team.id === session.currentTurnTeamId ? "highlight" : ""}">
                        <div class="team-card-head">
                          <div>
                            <strong>${team.name}</strong>
                            <span>总战力 ${team.totalPower}</span>
                          </div>
                          <span class="budget-chip">${team.members.length}/${session.teamSize}</span>
                        </div>
                        <div class="roster-list">${team.members.map((player) => playerCard(player)).join("")}</div>
                      </article>
                    `
                  )
                  .join("")}
              </div>
            `
              : `<p class="muted-line">管理员任命队长后，这里会开始显示选人面板。</p>`
          }
        </div>
      </div>
    </section>
  `;
}

function render() {
  clearInterval(state.countdownTimer);
  const pageContent =
    state.currentPage === "auction"
      ? renderAuctionHall()
      : state.currentPage === "inhouse"
        ? renderInhouseBoard()
        : isAdmin()
          ? `${renderAuthPanel()}${renderAdminWorkspace()}`
          : renderPlayerHome();
  app.innerHTML = `
    <div class="page-shell">
      ${renderPageNav()}
      ${pageContent}
    </div>
  `;

  bindEvents();

  state.countdownTimer = setInterval(() => {
    const node = document.querySelector("[data-auction-countdown]");
    const auction = getCurrentAuction();
    if (node && auction?.currentLot) {
      node.textContent = getAuctionCountdown(auction);
    }
  }, 1000);
}

function bindEvents() {
  const homePlayerKeyword = document.querySelector("#home-player-keyword");
  if (homePlayerKeyword) {
    homePlayerKeyword.addEventListener("input", () => {
      state.homePlayerFilters.keyword = homePlayerKeyword.value;
      render();
    });
  }

  const homePlayerPosition = document.querySelector("#home-player-position");
  if (homePlayerPosition) {
    homePlayerPosition.addEventListener("change", () => {
      state.homePlayerFilters.position = homePlayerPosition.value;
      render();
    });
  }

  const homePlayerSort = document.querySelector("#home-player-sort");
  if (homePlayerSort) {
    homePlayerSort.addEventListener("change", () => {
      state.homePlayerFilters.sort = homePlayerSort.value;
      render();
    });
  }

  const adminPlayerKeyword = document.querySelector("#admin-player-keyword");
  if (adminPlayerKeyword) {
    adminPlayerKeyword.addEventListener("input", () => {
      state.adminPlayerFilters.keyword = adminPlayerKeyword.value;
      render();
    });
  }

  const adminPlayerPosition = document.querySelector("#admin-player-position");
  if (adminPlayerPosition) {
    adminPlayerPosition.addEventListener("change", () => {
      state.adminPlayerFilters.position = adminPlayerPosition.value;
      render();
    });
  }

  const adminPlayerSort = document.querySelector("#admin-player-sort");
  if (adminPlayerSort) {
    adminPlayerSort.addEventListener("change", () => {
      state.adminPlayerFilters.sort = adminPlayerSort.value;
      render();
    });
  }

  const adminLoginForm = document.querySelector("#admin-login-form");
  if (adminLoginForm) {
    adminLoginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(adminLoginForm);
      try {
        const payload = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            type: "admin",
            password: formData.get("password")
          })
        });
        state.token = payload.token;
        saveSession();
        hydrate(payload.bootstrap);
        setNotice("管理员登录成功。", "success");
        connectStreams();
        render();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const playerLoginForm = document.querySelector("#player-login-form");
  if (playerLoginForm) {
    playerLoginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(playerLoginForm);
      try {
        const payload = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            type: "player",
            playerId: formData.get("playerId")
          })
        });
        state.token = payload.token;
        saveSession();
        hydrate(payload.bootstrap);
        setNotice("玩家登录成功。", "success");
        connectStreams();
        render();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const logoutButton = document.querySelector("#logout-button");
  if (logoutButton) {
    logoutButton.addEventListener("click", () => {
      state.token = "";
      state.auth = { role: "guest" };
      state.profile = null;
      saveSession();
      closeStreams();
      refreshBootstrap().catch((error) => {
        setNotice(error.message, "error");
        render();
      });
    });
  }

  document.querySelectorAll("[data-player-signup]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/events/${button.getAttribute("data-player-signup")}/signup`, {
          method: "POST",
          body: JSON.stringify({ action: "signup" })
        });
        setNotice("报名成功。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  });

  document.querySelectorAll("[data-player-cancel]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/events/${button.getAttribute("data-player-cancel")}/signup`, {
          method: "POST",
          body: JSON.stringify({ action: "cancel" })
        });
        setNotice("已取消报名。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  });

  const playerForm = document.querySelector("#player-form");
  if (playerForm) {
    playerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(playerForm);
      const currentId = formData.get("currentId");
      const payload = {
        id: formData.get("id"),
        displayName: formData.get("displayName"),
        wechatName: formData.get("wechatName"),
        mmr: Number(formData.get("mmr")),
        power: Number(formData.get("power")),
        positions: String(formData.get("positions") || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        intro: formData.get("intro")
      };
      try {
        if (currentId) {
          await api(`/api/players/${currentId}`, {
            method: "PATCH",
            body: JSON.stringify(payload)
          });
          setNotice("玩家信息已更新。", "success");
        } else {
          await api("/api/players", {
            method: "POST",
            body: JSON.stringify(payload)
          });
          setNotice("玩家已新增。", "success");
        }
        state.editingPlayerId = "";
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  document.querySelectorAll("[data-edit-player]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingPlayerId = button.getAttribute("data-edit-player");
      render();
    });
  });

  document.querySelectorAll("[data-delete-player]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/players/${button.getAttribute("data-delete-player")}`, {
          method: "DELETE"
        });
        setNotice("玩家已删除。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  });

  const cancelEditPlayer = document.querySelector("#cancel-edit-player");
  if (cancelEditPlayer) {
    cancelEditPlayer.addEventListener("click", () => {
      state.editingPlayerId = "";
      render();
    });
  }

  const eventForm = document.querySelector("#event-form");
  if (eventForm) {
    eventForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(eventForm);
      try {
        await api("/api/events", {
          method: "POST",
          body: JSON.stringify({
            name: formData.get("name"),
            startTime: formData.get("startTime"),
            teamSize: Number(formData.get("teamSize"))
          })
        });
        setNotice("赛事已创建。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const eventSwitcher = document.querySelector("#event-switcher");
  if (eventSwitcher) {
    eventSwitcher.addEventListener("change", async () => {
      state.selectedEventId = eventSwitcher.value;
      state.selectedInhouseId =
        state.inhouseSessions.find((session) => session.eventId === state.selectedEventId)?.id || "";
      state.selectedCaptainIds = [];
      connectStreams();
      render();
    });
  }

  document.querySelectorAll("[data-select-event]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedEventId = button.getAttribute("data-select-event");
      state.selectedInhouseId =
        state.inhouseSessions.find((session) => session.eventId === state.selectedEventId)?.id || "";
      state.selectedCaptainIds = [];
      connectStreams();
      render();
    });
  });

  const inhouseEventSwitcher = document.querySelector("#inhouse-event-switcher");
  if (inhouseEventSwitcher) {
    inhouseEventSwitcher.addEventListener("change", () => {
      state.selectedEventId = inhouseEventSwitcher.value;
      state.selectedInhouseId =
        state.inhouseSessions.find((session) => session.eventId === state.selectedEventId)?.id || "";
      connectStreams();
      render();
    });
  }

  document.querySelectorAll("[data-captain-checkbox]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      state.selectedCaptainIds = Array.from(document.querySelectorAll("[data-captain-checkbox]:checked")).map(
        (item) => item.value
      );
    });
  });

  const assignCaptainsButton = document.querySelector("#assign-captains-button");
  if (assignCaptainsButton) {
    assignCaptainsButton.addEventListener("click", async () => {
      try {
        await api(`/api/events/${state.selectedEventId}/captains`, {
          method: "POST",
          body: JSON.stringify({
            playerIds: state.selectedCaptainIds.length ? state.selectedCaptainIds : getCurrentEvent().captainIds
          })
        });
        setNotice("队长任命成功，内战选人已初始化。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const toggleEventSignupButton = document.querySelector("#toggle-event-signup-button");
  if (toggleEventSignupButton) {
    toggleEventSignupButton.addEventListener("click", async () => {
      const event = getCurrentEvent();
      try {
        await api(`/api/events/${event.id}`, {
          method: "PATCH",
          body: JSON.stringify({ signupOpen: !event.signupOpen })
        });
        setNotice(`已${event.signupOpen ? "关闭" : "开启"}该赛事报名。`, "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const deleteEventButton = document.querySelector("#delete-event-button");
  if (deleteEventButton) {
    deleteEventButton.addEventListener("click", async () => {
      try {
        await api(`/api/events/${state.selectedEventId}`, {
          method: "DELETE"
        });
        setNotice("赛事已删除。", "success");
        state.selectedEventId = "";
        state.selectedInhouseId = "";
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const adminSignupButton = document.querySelector("#admin-signup-button");
  if (adminSignupButton) {
    adminSignupButton.addEventListener("click", async () => {
      const playerId = document.querySelector("#admin-signup-player")?.value;
      try {
        await api(`/api/events/${state.selectedEventId}/signup`, {
          method: "POST",
          body: JSON.stringify({ action: "signup", playerId })
        });
        setNotice("管理员已为该玩家报名当前赛事。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const auctionForm = document.querySelector("#auction-form");
  if (auctionForm) {
    auctionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(auctionForm);
      const budgetMap = {};
      const currentEvent = state.events.find((item) => item.id === formData.get("eventId")) || getCurrentEvent();
      currentEvent?.captains?.forEach((captain) => {
        budgetMap[captain.id] = Number(formData.get(`budget_${captain.id}`) || 0);
      });
      try {
        await api("/api/auctions", {
          method: "POST",
          body: JSON.stringify({
            eventId: formData.get("eventId"),
            title: formData.get("title"),
            startPrice: Number(formData.get("startPrice")),
            increment: Number(formData.get("increment")),
            bidTimeoutSec: Number(formData.get("bidTimeoutSec")),
            budgetMap
          })
        });
        setNotice("拍卖已创建。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const auctionSwitcher = document.querySelector("#auction-switcher");
  if (auctionSwitcher) {
    auctionSwitcher.addEventListener("change", () => {
      state.selectedAuctionId = auctionSwitcher.value;
      connectStreams();
      render();
    });
  }

  const startAuctionButton = document.querySelector("#start-auction-button");
  if (startAuctionButton) {
    startAuctionButton.addEventListener("click", async () => {
      try {
        await api(`/api/auctions/${state.selectedAuctionId}/start`, {
          method: "POST",
          body: JSON.stringify({})
        });
        setNotice("拍卖已启动。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const resumeAuctionButton = document.querySelector("#resume-auction-button");
  if (resumeAuctionButton) {
    resumeAuctionButton.addEventListener("click", async () => {
      try {
        await api(`/api/auctions/${state.selectedAuctionId}/start`, {
          method: "POST",
          body: JSON.stringify({})
        });
        setNotice("拍卖已继续。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const pauseAuctionButton = document.querySelector("#pause-auction-button");
  if (pauseAuctionButton) {
    pauseAuctionButton.addEventListener("click", async () => {
      try {
        await api(`/api/auctions/${state.selectedAuctionId}/pause`, {
          method: "POST",
          body: JSON.stringify({})
        });
        setNotice("拍卖已暂停。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const resumeAuctionInlineButton = document.querySelector("#resume-auction-inline-button");
  if (resumeAuctionInlineButton) {
    resumeAuctionInlineButton.addEventListener("click", async () => {
      try {
        await api(`/api/auctions/${state.selectedAuctionId}/start`, {
          method: "POST",
          body: JSON.stringify({})
        });
        setNotice("拍卖已继续。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const signupButton = document.querySelector("#signup-button");
  if (signupButton) {
    signupButton.addEventListener("click", async () => {
      try {
        await api(`/api/events/${state.selectedEventId}/signup`, {
          method: "POST",
          body: JSON.stringify({ action: "signup" })
        });
        setNotice("报名成功。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const cancelSignupButton = document.querySelector("#cancel-signup-button");
  if (cancelSignupButton) {
    cancelSignupButton.addEventListener("click", async () => {
      try {
        await api(`/api/events/${state.selectedEventId}/signup`, {
          method: "POST",
          body: JSON.stringify({ action: "cancel" })
        });
        setNotice("已取消报名。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  document.querySelectorAll('input[name="pickPlayer"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      state.selectedPickPlayerId = radio.value;
      render();
    });
  });

  const pickPlayerButton = document.querySelector("#pick-player-button");
  if (pickPlayerButton) {
    pickPlayerButton.addEventListener("click", async () => {
      try {
        await api(`/api/inhouse/${state.selectedInhouseId}/picks`, {
          method: "POST",
          body: JSON.stringify({ playerId: state.selectedPickPlayerId })
        });
        setNotice("队员已选中。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  const bidForm = document.querySelector("#bid-form");
  if (bidForm) {
    const amountInput = bidForm.querySelector('input[name="amount"]');
    const auction = getCurrentAuction();
    const minAmount = auction?.currentLot?.leadingTeamId
      ? auction.currentLot.currentPrice + auction.config.increment
      : Math.max(auction?.currentLot?.currentPrice || 0, auction?.config?.startPrice || 0);
    const changeBid = (delta) => {
      const next = Math.max(minAmount, Number(amountInput.value || minAmount) + delta);
      amountInput.value = next;
    };
    document.querySelector("#decrease-bid")?.addEventListener("click", () => changeBid(-auction.config.increment));
    document.querySelector("#increase-bid")?.addEventListener("click", () => changeBid(auction.config.increment));
    bidForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api(`/api/auctions/${state.selectedAuctionId}/bids`, {
          method: "POST",
          body: JSON.stringify({ amount: Number(amountInput.value) })
        });
        setNotice("出价成功。", "success");
        await refreshBootstrap();
      } catch (error) {
        setNotice(error.message, "error");
        render();
      }
    });
  }

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      setPage(button.getAttribute("data-page"));
      render();
    });
  });
}

window.addEventListener("beforeunload", closeStreams);

(async function init() {
  state.token = localStorage.getItem("dcms-token") || "";
  state.currentPage = localStorage.getItem("dcms-page") || "hub";
  try {
    await refreshBootstrap();
  } catch (error) {
    state.token = "";
    saveSession();
    setNotice(error.message, "error");
    render();
  }
})();
