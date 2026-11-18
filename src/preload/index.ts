import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, PeerEvent } from '../shared/api';

const api: DesktopApi = {
  getInfo: () => ipcRenderer.invoke('app:info'),
  listContacts: () => ipcRenderer.invoke('contacts:list'),
  addContact: (ip, port, name) => ipcRenderer.invoke('contacts:add', { ip, port, name }),
  editContact: (id, ip, port, name) => ipcRenderer.invoke('contacts:edit', { id, ip, port, name }),
  deleteContact: id => ipcRenderer.invoke('contacts:delete', id),
  connect: (ip, port, name) => ipcRenderer.invoke('peer:connect', { ip, port, name }),
  acceptRequest: requestId => ipcRenderer.invoke('peer:accept', requestId),
  rejectRequest: requestId => ipcRenderer.invoke('peer:reject', requestId),
  sendMessage: (peerId, text) => ipcRenderer.invoke('chat:send', { peerId, text }),
  loadMessages: (peerId, before) => ipcRenderer.invoke('chat:history', { peerId, before }),
  loadHistory: (peerId, before) => ipcRenderer.invoke('chat:timeline', { peerId, before }),
  sendDroppedFiles: (peerId, files) => {
    const paths = Array.from(files, file => webUtils.getPathForFile(file));
    if (!paths.length || paths.some(path => !path)) return Promise.reject(new Error('请从文件管理器拖入本地文件，不支持网页图片链接或文件夹'));
    return ipcRenderer.invoke('files:drop', { peerId, paths });
  },
  imageContextMenu: id => ipcRenderer.invoke('images:menu', id),
  cancelTransfer: transferId => ipcRenderer.invoke('files:cancel', transferId),
  disconnect: peerId => ipcRenderer.invoke('peer:disconnect', peerId),
  onEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PeerEvent) => callback(payload);
    ipcRenderer.on('peer:event', listener);
    return () => ipcRenderer.removeListener('peer:event', listener);
  }
};

contextBridge.exposeInMainWorld('desktop', api);
