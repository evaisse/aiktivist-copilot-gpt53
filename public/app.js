const loginView = document.getElementById("login-view");
const chatView = document.getElementById("chat-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const sessionInfo = document.getElementById("session-info");
const list = document.getElementById("conversation-list");
const title = document.getElementById("conversation-title");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const streamState = document.getElementById("stream-state");
const eventLog = document.getElementById("event-log");
const archiveToggle = document.getElementById("archive-toggle");
const deleteConversation = document.getElementById("delete-conversation");
const newConversation = document.getElementById("new-conversation");
const logoutBtn = document.getElementById("logout");

let me = null;
let conversations = [];
let currentConversationId = null;
let currentMessages = [];
let eventSource = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });

  if (response.status === 401) {
    setAuth(false);
    throw new Error("unauthorized");
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

function setAuth(isAuthed) {
  loginView.classList.toggle("hidden", isAuthed);
  chatView.classList.toggle("hidden", !isAuthed);
}

function renderConversations() {
  list.innerHTML = "";
  conversations.forEach((conv) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = conv.id === currentConversationId ? "active" : "";
    button.textContent = `${conv.archived ? "[archived] " : ""}${conv.title}`;
    button.onclick = () => openConversation(conv.id);
    li.appendChild(button);
    list.appendChild(li);
  });
}

function renderMessages() {
  messagesEl.innerHTML = "";
  currentMessages.forEach((msg) => {
    const line = document.createElement("div");
    line.className = `message ${msg.role}`;
    line.innerHTML = `<span class="role">${msg.role}</span>: ${escapeHtml(msg.content)} <span class="meta">${msg.status}</span>`;
    messagesEl.appendChild(line);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function refreshConversations() {
  conversations = await api("/api/conversations");
  renderConversations();
}

async function refreshMessages(conversationId) {
  currentMessages = await api(`/api/conversations/${conversationId}/messages`);
  renderMessages();
  const conv = conversations.find((x) => x.id === conversationId);
  if (conv) {
    title.textContent = conv.title;
    archiveToggle.textContent = conv.archived ? "unarchive" : "archive";
  }
}

function openStream(conversationId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/conversations/${conversationId}/stream`);
  eventSource.onmessage = async (event) => {
    try {
      const payload = JSON.parse(event.data);
      eventLog.textContent += `${payload.id} ${payload.eventType} ${JSON.stringify(payload.payload)}\n`;
      eventLog.scrollTop = eventLog.scrollHeight;
      if (payload.eventType.includes("chunk") || payload.eventType.includes("completed") || payload.eventType.includes("error")) {
        streamState.textContent = payload.eventType;
        await refreshMessages(conversationId);
      }
    } catch {
      // ignore parse errors
    }
  };
  eventSource.onerror = () => {
    streamState.textContent = "stream disconnected";
  };
}

async function openConversation(id) {
  currentConversationId = id;
  history.replaceState({}, "", `/c/${id}`);
  renderConversations();
  await refreshMessages(id);
  openStream(id);
}

async function initialize() {
  try {
    me = await api("/api/me");
  } catch {
    setAuth(false);
    return;
  }

  setAuth(true);
  sessionInfo.textContent = `logged as ${me.username}`;

  await refreshConversations();

  const pathMatch = location.pathname.match(/^\/c\/(\d+)$/);
  const pathId = pathMatch ? Number(pathMatch[1]) : null;
  if (pathId && conversations.some((x) => x.id === pathId)) {
    await openConversation(pathId);
    return;
  }

  if (conversations[0]) {
    await openConversation(conversations[0].id);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const form = new FormData(loginForm);
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: String(form.get("username") || ""),
        password: String(form.get("password") || "")
      })
    });
    await initialize();
  } catch {
    loginError.textContent = "invalid credentials";
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentConversationId) return;
  const content = messageInput.value.trim();
  if (!content) return;
  messageInput.value = "";
  streamState.textContent = "thinking";
  await api(`/api/conversations/${currentConversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content })
  });
  await refreshMessages(currentConversationId);
});

archiveToggle.addEventListener("click", async () => {
  if (!currentConversationId) return;
  const conv = conversations.find((c) => c.id === currentConversationId);
  if (!conv) return;
  await api(`/api/conversations/${currentConversationId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: !conv.archived })
  });
  await refreshConversations();
  await refreshMessages(currentConversationId);
});

deleteConversation.addEventListener("click", async () => {
  if (!currentConversationId) return;
  await api(`/api/conversations/${currentConversationId}`, { method: "DELETE" });
  currentConversationId = null;
  eventLog.textContent = "";
  await refreshConversations();
  if (conversations[0]) await openConversation(conversations[0].id);
});

newConversation.addEventListener("click", async () => {
  const created = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: `conversation ${new Date().toLocaleTimeString()}` })
  });
  await refreshConversations();
  await openConversation(created.id);
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  if (eventSource) eventSource.close();
  me = null;
  conversations = [];
  currentConversationId = null;
  setAuth(false);
});

initialize();
