chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'papermind-highlight',
    title: 'Highlight with PaperMind',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'papermind-ask',
    title: 'Ask PaperMind about this',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: 'papermind-summarize',
    title: 'Summarize this page',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'papermind-highlight' && info.selectionText) {
    chrome.storage.local.get(['highlights'], (result) => {
      const highlights = result.highlights || [];
      highlights.push({
        id: Date.now().toString(),
        text: info.selectionText,
        url: tab.url,
        pageTitle: tab.title,
        color: getRandomColor(),
        createdAt: new Date().toISOString()
      });
      chrome.storage.local.set({ highlights });
    });

    chrome.tabs.sendMessage(tab.id, {
      action: 'highlight',
      text: info.selectionText,
      color: getRandomColor()
    });
  }

  if (info.menuItemId === 'papermind-ask' && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'ask',
      text: info.selectionText
    });
  }

  if (info.menuItemId === 'papermind-summarize') {
    chrome.tabs.sendMessage(tab.id, {
      action: 'summarize'
    });
  }
});

function getRandomColor() {
  const colors = ['#FEF3C7', '#DBEAFE', '#D1FAE5', '#FCE7F3', '#E0E7FF'];
  return colors[Math.floor(Math.random() * colors.length)];
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getHighlights') {
    chrome.storage.local.get(['highlights'], (result) => {
      sendResponse({ highlights: result.highlights || [] });
    });
    return true;
  }

  if (request.action === 'addNote') {
    chrome.storage.local.get(['notes'], (result) => {
      const notes = result.notes || [];
      notes.push({
        id: Date.now().toString(),
        ...request.data,
        createdAt: new Date().toISOString()
      });
      chrome.storage.local.set({ notes });
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'getNotes') {
    chrome.storage.local.get(['notes'], (result) => {
      sendResponse({ notes: result.notes || [] });
    });
    return true;
  }
});
