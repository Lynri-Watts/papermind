let sidebarOpen = false;
let currentHighlights = [];

function createSidebar() {
  if (document.getElementById('papermind-sidebar')) {
    return;
  }

  const sidebar = document.createElement('div');
  sidebar.id = 'papermind-sidebar';
  sidebar.className = 'papermind-sidebar';
  sidebar.innerHTML = `
    <div class="papermind-sidebar-header">
      <div class="papermind-logo">
        <span class="papermind-icon">📚</span>
        <span class="papermind-title">PaperMind</span>
      </div>
      <button class="papermind-close-btn" onclick="toggleSidebar()">✕</button>
    </div>
    <div class="papermind-sidebar-tabs">
      <button class="papermind-tab active" onclick="switchTab('notes')">Notes</button>
      <button class="papermind-tab" onclick="switchTab('qa')">AI Q&A</button>
      <button class="papermind-tab" onclick="switchTab('highlights')">Highlights</button>
    </div>
    <div class="papermind-sidebar-content">
      <div id="papermind-tab-notes" class="papermind-tab-content active">
        <div class="papermind-note-input">
          <textarea placeholder="Add a note..." id="papermind-note-text"></textarea>
          <button class="papermind-add-note-btn" onclick="addNote()">Add Note</button>
        </div>
        <div id="papermind-notes-list" class="papermind-notes-list"></div>
      </div>
      <div id="papermind-tab-qa" class="papermind-tab-content">
        <div id="papermind-chat-list" class="papermind-chat-list">
          <div class="papermind-chat-message assistant">
            <p>Hello! I'm PaperMind, your AI research assistant. Select text or ask me anything.</p>
          </div>
        </div>
        <div class="papermind-chat-input">
          <input type="text" placeholder="Ask a question..." id="papermind-qa-input">
          <button class="papermind-send-btn" onclick="sendQAMessage()">Send</button>
        </div>
      </div>
      <div id="papermind-tab-highlights" class="papermind-tab-content">
        <div id="papermind-highlights-list" class="papermind-highlights-list"></div>
      </div>
    </div>
  `;

  document.body.appendChild(sidebar);
  loadNotes();
  loadHighlights();

  const qaInput = document.getElementById('papermind-qa-input');
  qaInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendQAMessage();
  });
}

function toggleSidebar() {
  const sidebar = document.getElementById('papermind-sidebar');
  if (!sidebar) {
    createSidebar();
    sidebarOpen = true;
    return;
  }

  sidebarOpen = !sidebarOpen;
  sidebar.style.transform = sidebarOpen ? 'translateX(0)' : 'translateX(100%)';
}

function switchTab(tabName) {
  document.querySelectorAll('.papermind-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('.papermind-tab-content').forEach(content => {
    content.classList.remove('active');
  });

  event.target.classList.add('active');
  document.getElementById(`papermind-tab-${tabName}`).classList.add('active');
}

function addNote() {
  const textarea = document.getElementById('papermind-note-text');
  const content = textarea.value.trim();
  
  if (!content) return;

  chrome.runtime.sendMessage({
    action: 'addNote',
    data: {
      content,
      url: window.location.href,
      pageTitle: document.title
    }
  }, () => {
    textarea.value = '';
    loadNotes();
  });
}

function loadNotes() {
  chrome.runtime.sendMessage({ action: 'getNotes' }, (response) => {
    const notesList = document.getElementById('papermind-notes-list');
    const notes = response.notes || [];
    const currentPageNotes = notes.filter(note => note.url === window.location.href);

    if (currentPageNotes.length === 0) {
      notesList.innerHTML = '<div class="papermind-empty">No notes for this page.</div>';
      return;
    }

    notesList.innerHTML = currentPageNotes.map(note => `
      <div class="papermind-note-item">
        <p>${note.content}</p>
        <span class="papermind-note-date">${new Date(note.createdAt).toLocaleString()}</span>
      </div>
    `).join('');
  });
}

function loadHighlights() {
  chrome.runtime.sendMessage({ action: 'getHighlights' }, (response) => {
    const highlightsList = document.getElementById('papermind-highlights-list');
    const highlights = response.highlights || [];
    const currentPageHighlights = highlights.filter(h => h.url === window.location.href);

    currentHighlights = currentPageHighlights;

    if (currentPageHighlights.length === 0) {
      highlightsList.innerHTML = '<div class="papermind-empty">No highlights for this page.</div>';
      return;
    }

    highlightsList.innerHTML = currentPageHighlights.map(highlight => `
      <div class="papermind-highlight-item" style="border-left-color: ${highlight.color}">
        <p style="background-color: ${highlight.color}40">${highlight.text}</p>
        <span class="papermind-highlight-date">${new Date(highlight.createdAt).toLocaleString()}</span>
      </div>
    `).join('');
  });
}

function sendQAMessage() {
  const input = document.getElementById('papermind-qa-input');
  const chatList = document.getElementById('papermind-chat-list');
  const query = input.value.trim();

  if (!query) return;

  chatList.innerHTML += `
    <div class="papermind-chat-message user">
      <p>${query}</p>
    </div>
  `;

  input.value = '';
  chatList.scrollTop = chatList.scrollHeight;

  chatList.innerHTML += `
    <div class="papermind-chat-message assistant loading">
      <div class="papermind-loading">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  chatList.scrollTop = chatList.scrollHeight;

  setTimeout(() => {
    const loadingMsg = chatList.querySelector('.loading');
    if (loadingMsg) {
      loadingMsg.remove();
    }

    const answers = [
      'This is an interesting point. Based on my analysis, this concept relates to the broader field of deep learning and natural language processing.',
      'I can help you understand this better. The key insight here is the attention mechanism that allows models to focus on relevant information.',
      'This seems to be discussing a novel approach to solving a complex problem. Would you like me to explain similar approaches in the literature?',
      'The research presented here builds upon foundational work in the field. Key references include attention mechanisms and transformer architectures.',
      'This is a significant finding. The methodology appears robust and the results are compelling. Have you considered related work in this area?'
    ];

    const randomAnswer = answers[Math.floor(Math.random() * answers.length)];

    chatList.innerHTML += `
      <div class="papermind-chat-message assistant">
        <p>${randomAnswer}</p>
      </div>
    `;
    chatList.scrollTop = chatList.scrollHeight;
  }, 1500);
}

function highlightText(text, color) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  const span = document.createElement('span');
  span.className = 'papermind-highlight';
  span.style.backgroundColor = color;
  span.style.borderRadius = '3px';
  span.style.padding = '1px 3px';

  try {
    range.surroundContents(span);
  } catch (e) {
    console.error('Highlight failed:', e);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'highlight') {
    highlightText(request.text, request.color);
    loadHighlights();
  }

  if (request.action === 'ask') {
    toggleSidebar();
    switchTab('qa');
    const input = document.getElementById('papermind-qa-input');
    input.value = `Explain: ${request.text}`;
  }

  if (request.action === 'summarize') {
    toggleSidebar();
    switchTab('qa');
    const input = document.getElementById('papermind-qa-input');
    input.value = 'Summarize this page';
    sendQAMessage();
  }
});

chrome.action.onClicked.addListener(() => {
  toggleSidebar();
});
