// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'fineprint-check-selection',
    title: 'Check selected terms with Fine Print',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'fineprint-check-selection' || !tab?.windowId) return;
  await chrome.storage.session.set({ pendingSelection: { tabId: tab.id, at: Date.now() } });
  await chrome.sidePanel.open({ windowId: tab.windowId });
});
