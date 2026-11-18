import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, IncomingRequest } from '../../shared/api';
import type { ChatMessage } from '../../shared/protocol';
import type { Contact } from '../../main/storage/database';
import { connectionRejectionMessage } from '../../shared/connection-errors';
import { imageUrl, type ChatFile, type HistoryEntry, type TransferProgress } from '../../shared/history';

const formatSize = (size: number) => size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const fileStatus: Record<ChatFile['status'], string> = { waiting: '等待保存位置', transferring: '传输中', sent: '已送达', received: '已接收', cancelled: '已取消', failed: '传输失败' };
const mergeEntries = (current: HistoryEntry[], incoming: HistoryEntry[]) => {
  const entries = new Map(current.map(entry => [entry.id, entry]));
  for (const entry of incoming) entries.set(entry.id, entry);
  return [...entries.values()];
};

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activePeer, setActivePeer] = useState<string>();
  const [selectedContactId, setSelectedContactId] = useState<number>();
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<Array<{ peerId: string; name: string; ip: string }>>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [text, setText] = useState('');
  const [requests, setRequests] = useState<IncomingRequest[]>([]);
  const [progress, setProgress] = useState<TransferProgress[]>([]);
  const [notice, setNotice] = useState('');
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [form, setForm] = useState({ name: '', ip: '', port: '45873' });
  const [editingContact, setEditingContact] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ChatFile>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const messagesRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const pinnedToBottom = useRef(true);
  const olderScroll = useRef<{ height: number; top: number }>();
  const selected = contacts.find(item => item.id === selectedContactId) ?? contacts.find(item => item.peerId === activePeer);
  const activeSession = sessions.find(session => session.peerId === activePeer);
  const contactLabel = selected?.name ?? activeSession?.name ?? '选择联系人开始聊天';
  const entries = useMemo(() => history.filter(entry => entry.peerId === activePeer).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), [history, activePeer]);
  const lastEntryId = entries.at(-1)?.id;
  const isConnected = Boolean(activePeer && connected.has(activePeer));

  function showError(reason: unknown) { setNotice(reason instanceof Error ? reason.message : String(reason)); }
  function scrollToBottom() {
    const list = messagesRef.current;
    if (list) { list.scrollTop = list.scrollHeight; pinnedToBottom.current = true; }
  }
  useLayoutEffect(() => {
    if (olderScroll.current) {
      const list = messagesRef.current;
      if (list) list.scrollTop = olderScroll.current.top + list.scrollHeight - olderScroll.current.height;
      pinnedToBottom.current = false;
      olderScroll.current = undefined;
      return;
    }
    scrollToBottom();
  }, [lastEntryId, activePeer, entries.length]);

  useEffect(() => {
    void Promise.all([window.desktop.getInfo(), window.desktop.listContacts()]).then(([localInfo, list]) => { setInfo(localInfo); setContacts(list); }).catch(showError);
    return window.desktop.onEvent(({ event, payload }) => {
      if (event === 'incoming-request') setRequests(current => [...current, payload as IncomingRequest]);
      else if (event === 'request-expired') setRequests(current => current.filter(request => request.requestId !== (payload as { requestId: string }).requestId));
      else if (event === 'connected') {
        const peer = payload as { peerId: string; name: string; ip: string };
        setConnected(current => new Set(current).add(peer.peerId));
        setSessions(current => [...current.filter(session => session.peerId !== peer.peerId), peer]);
        setSelectedContactId(undefined);
        setActivePeer(peer.peerId);
        void window.desktop.listContacts().then(setContacts).catch(showError);
      } else if (event === 'disconnected') {
        const { peerId } = payload as { peerId: string };
        setConnected(current => { const next = new Set(current); next.delete(peerId); return next; });
        setProgress(current => current.filter(item => item.peerId !== peerId));
        setNotice('连接已断开，未完成的传输已停止');
      } else if (event === 'message') {
        const message = payload as ChatMessage;
        setHistory(current => mergeEntries(current, [{ ...message, kind: 'text' }]));
      } else if (event === 'ack') {
        setHistory(current => current.map(item => item.id === payload && item.kind === 'text' ? { ...item, status: 'delivered' } : item));
      } else if (event === 'file-history') {
        const file = payload as ChatFile;
        setHistory(current => mergeEntries(current, [file]));
        if (['sent', 'received', 'failed', 'cancelled'].includes(file.status)) {
          setProgress(current => current.filter(item => `${item.transferId}:${item.fileIndex}` !== file.id));
        }
      } else if (event === 'progress') {
        const item = payload as TransferProgress;
        setProgress(current => [...current.filter(entry => entry.transferId !== item.transferId || entry.fileIndex !== item.fileIndex), item]);
      } else if (event === 'transfer-ended') {
        const { transferId } = payload as { transferId: string };
        setProgress(current => current.filter(item => item.transferId !== transferId));
      } else if (event === 'file-result') {
        const result = payload as { accepted: boolean; error?: string };
        if (!result.accepted && result.error) showError(new Error(result.error));
      } else if (event === 'saved-image') setNotice('图片已保存');
      else if (event === 'error-message') showError(new Error(String(payload)));
    });
  }, []);

  useEffect(() => {
    if (!activePeer) return;
    let active = true;
    setHasOlder(true);
    void window.desktop.loadHistory(activePeer).then(records => {
      if (!active) return;
      // Events arriving during history loading must retain their newer delivery state.
      setHistory(current => mergeEntries(records, current));
      setHasOlder(records.length === 100);
    }).catch(showError);
    return () => { active = false; };
  }, [activePeer]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPreview(undefined); setContactFormOpen(false); } };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  async function addContact(event: React.FormEvent) {
    event.preventDefault();
    try {
      setContacts(editingContact
        ? await window.desktop.editContact(editingContact, form.ip.trim(), Number(form.port), form.name.trim())
        : await window.desktop.addContact(form.ip.trim(), Number(form.port), form.name.trim()));
      setForm({ name: '', ip: '', port: '45873' });
      setEditingContact(undefined);
      setContactFormOpen(false);
    } catch (reason) { showError(reason); }
  }
  async function connect(contact: Contact) {
    if (connecting) return;
    setConnecting(true);
    setNotice('');
    try {
      const peer = await window.desktop.connect(contact.ip, contact.port, contact.name);
      if (!peer.ok) { if (peer.reason !== 'cancelled') setNotice(connectionRejectionMessage(peer.reason)); return; }
      setActivePeer(peer.peerId);
      setSelectedContactId(contact.id);
      setSessions(current => [...current.filter(session => session.peerId !== peer.peerId), { peerId: peer.peerId, name: peer.name, ip: contact.ip }]);
      setConnected(current => new Set(current).add(peer.peerId));
      setContacts(await window.desktop.listContacts());
    } catch (reason) { showError(reason); }
    finally { setConnecting(false); }
  }
  async function disconnect() {
    if (!activePeer) return;
    try {
      await window.desktop.disconnect(activePeer);
      setConnected(current => { const next = new Set(current); next.delete(activePeer); return next; });
      setProgress(current => current.filter(item => item.peerId !== activePeer));
    } catch (reason) { showError(reason); }
  }
  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!activePeer || !text.trim()) return;
    try { await window.desktop.sendMessage(activePeer, text.trim()); setText(''); }
    catch (reason) { showError(reason); }
  }
  async function dropFiles(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) { setNotice('请从文件管理器拖入本地文件'); return; }
    if (!activePeer || !isConnected) { setNotice('请先连接联系人，再拖入文件发送'); return; }
    try { await window.desktop.sendDroppedFiles(activePeer, files); }
    catch (reason) { showError(reason); }
  }
  async function loadOlder() {
    if (!activePeer || !entries[0] || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const records = await window.desktop.loadHistory(activePeer, { createdAt: entries[0].createdAt, id: entries[0].id });
      const list = messagesRef.current;
      if (list && records.length) olderScroll.current = { height: list.scrollHeight, top: list.scrollTop };
      setHistory(current => mergeEntries(records, current));
      setHasOlder(records.length === 100);
    } catch (reason) { showError(reason); }
    finally { setLoadingOlder(false); }
  }
  return <main className="app-shell" onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <aside className="sidebar">
      <header className="sidebar-header"><span className="brand-mark">↗</span><strong>局域网直连</strong><span className="online-dot" title="监听已启动" /></header>
      <details className="local-details"><summary>{info?.addresses[0] ?? '正在获取本机地址'}{info ? `:${info.port}` : ''}{info && info.addresses.length > 1 ? ` +${info.addresses.length - 1}` : ''}</summary>
        <small>{info?.name}</small>{info?.addresses.map(address => <code key={address}>{address}:{info.port}</code>)}
        <small>身份指纹（SHA-256）</small><code className="fingerprint">{info?.fingerprint}</code>
      </details>
      <div className="contacts-heading"><span>通讯录 <span className="count">{contacts.length}</span></span><button className="icon-button" title="添加联系人" aria-label="添加联系人" onClick={() => { setEditingContact(undefined); setForm({ name: '', ip: '', port: '45873' }); setContactFormOpen(true); }}>＋</button></div>
      <div className="contacts-list">
        {contacts.map(contact => <button key={contact.id} className={`contact ${selectedContactId === contact.id || activePeer === contact.peerId ? 'selected' : ''}`} onClick={() => { setSelectedContactId(contact.id); setActivePeer(contact.peerId ?? undefined); }}>
          <span className={`avatar ${connected.has(contact.peerId ?? '') ? 'active' : ''}`}>{contact.name.slice(0, 1)}</span>
          <span className="contact-copy"><strong>{contact.name}</strong><small>{contact.ip}:{contact.port}</small></span><span className={`status ${connected.has(contact.peerId ?? '') ? 'up' : ''}`} />
        </button>)}
        {sessions.filter(session => !contacts.some(contact => contact.peerId === session.peerId)).map(session => <button key={session.peerId} className={`contact ${activePeer === session.peerId ? 'selected' : ''}`} onClick={() => { setSelectedContactId(undefined); setActivePeer(session.peerId); }}>
          <span className={`avatar ${connected.has(session.peerId) ? 'active' : ''}`}>{session.name.slice(0, 1)}</span>
          <span className="contact-copy"><strong>{session.name}</strong><small>{session.ip} · 临时会话</small></span><span className={`status ${connected.has(session.peerId) ? 'up' : ''}`} />
        </button>)}
        {!contacts.length && !sessions.length && <div className="empty-contacts">点击右上角 ＋ 添加同事<br />输入对方的局域网 IP</div>}
      </div>
      <div className="sidebar-foot">仅在双方打开应用时连接</div>
    </aside>
    <section className={`chat-pane ${dragging ? 'dragging' : ''}`} onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }} onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = isConnected ? 'copy' : 'none'; }} onDrop={event => void dropFiles(event)}>
      <header className="chat-header">
        <div className="chat-person"><span className="avatar large">{contactLabel.slice(0, 1)}</span><div><strong>{contactLabel}</strong><small>{activePeer ? (isConnected ? '已建立加密连接 · 可拖入文件或图片' : '未连接') : '聊天记录仅保存在本机'}</small></div></div>
        <div className="header-actions">
          {selected && !isConnected && <button className="primary" disabled={connecting} onClick={() => void connect(selected)}>{connecting ? '等待对方处理…' : '发起连接'}</button>}
          {isConnected && <button className="icon-button" title="断开连接" onClick={() => void disconnect()}>⤫</button>}
          {selected && <><button className="icon-button" title="编辑联系人" onClick={() => { setEditingContact(selected.id); setForm({ name: selected.name, ip: selected.ip, port: String(selected.port) }); setContactFormOpen(true); }}>✎</button>
            <button className="icon-button" title="删除联系人" onClick={() => { if (confirm(`删除联系人“${selected.name}”？聊天记录会保留。`)) void window.desktop.deleteContact(selected.id).then(setContacts).catch(showError); }}>⋯</button></>}
        </div>
      </header>
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')}>关闭</button></div>}
      <div className="requests">{requests.map(request => <div className="request-card" key={request.requestId}><span><b>{request.name}</b>（{request.ip}）请求连接</span><span className="request-actions"><button className="primary" onClick={() => void window.desktop.acceptRequest(request.requestId).then(() => setRequests(current => current.filter(item => item.requestId !== request.requestId))).catch(showError)}>查看并处理</button><button className="text-button" onClick={() => void window.desktop.rejectRequest(request.requestId).then(() => setRequests(current => current.filter(item => item.requestId !== request.requestId))).catch(showError)}>拒绝</button></span></div>)}</div>
      <div className="messages" ref={messagesRef} data-testid="messages" onScroll={() => { const list = messagesRef.current; if (list) pinnedToBottom.current = list.scrollHeight - list.clientHeight - list.scrollTop < 24; }}>
        {activePeer && hasOlder && !!entries.length && <button className="text-button history-button" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '加载中…' : '加载更早的记录'}</button>}
        {!entries.length && <div className="welcome"><div className="welcome-icon">✳</div><h2>{activePeer ? '开始对话' : '让沟通留在局域网'}</h2><p>{activePeer ? '连接后可直接拖入文件或图片。普通文件选择保存位置，图片自动显示在聊天中。' : '选择联系人，待对方接受连接后，开始聊天或拖入文件发送。'}</p></div>}
        {entries.map(entry => {
          const transfer = entry.kind === 'file' ? progress.find(item => `${item.transferId}:${item.fileIndex}` === entry.id) : undefined;
          return <article className={`message-row ${entry.direction}`} key={entry.id} data-entry-id={entry.id}><div className={`message-bubble ${entry.kind === 'file' ? 'file-bubble' : ''}`}>
            {entry.kind === 'text' ? <p>{entry.text}</p> : <>
              {entry.image && ['sent', 'received'].includes(entry.status) ? <button className="image-button" title="点击预览，右键保存图片" onClick={() => setPreview(entry)} onContextMenu={event => { event.preventDefault(); void window.desktop.imageContextMenu(entry.id).catch(showError); }}><img src={imageUrl(entry.id)} alt={entry.name} onLoad={() => { if (pinnedToBottom.current) scrollToBottom(); }} onError={() => setNotice(`图片缓存不可用：${entry.name}`)} /></button> : <div className="file-title"><span className="file-icon">▤</span><span><b>{entry.name}</b><small>{formatSize(entry.size)}</small></span></div>}
              <div className="file-state"><span>{fileStatus[entry.status]}</span>{transfer && <span>{formatSize(transfer.transferred)} / {formatSize(transfer.total)}</span>}{['waiting', 'transferring'].includes(entry.status) && <button className="text-button" onClick={() => void window.desktop.cancelTransfer(entry.id.split(':')[0]!).catch(showError)}>取消</button>}</div>
              {transfer && <progress max={Math.max(transfer.total, 1)} value={transfer.transferred} />}
            </>}
            <small className="message-time">{new Date(entry.createdAt).toLocaleTimeString()} {entry.kind === 'text' ? `· ${entry.status === 'delivered' ? '已送达' : entry.status === 'received' ? '已接收' : entry.status === 'failed' ? '结果未知/未送达' : '发送中'}` : ''}</small>
          </div></article>;
        })}
      </div>
      <form className="composer" onSubmit={sendMessage}><input disabled={!isConnected} value={text} onChange={event => setText(event.target.value)} placeholder={isConnected ? '输入消息，或拖入文件 / 图片…' : '连接并等待对方接受后开始聊天'} maxLength={16_000} /><button className="send-button" disabled={!isConnected || !text.trim()} type="submit" aria-label="发送消息">↑</button></form>
      <footer className="encryption-note">TLS 加密直连 · 拖入即发送 · 图片自动接收，文件选择保存位置</footer>
      {dragging && <div className="drop-overlay">{isConnected ? '松开发送文件或图片' : '请先连接联系人'}</div>}
    </section>
    {contactFormOpen && <div className="modal-backdrop" onClick={() => setContactFormOpen(false)}><form className="contact-modal" role="dialog" aria-modal="true" aria-label={editingContact ? '编辑联系人' : '添加联系人'} onSubmit={addContact} onClick={event => event.stopPropagation()}><div className="modal-heading"><h2>{editingContact ? '编辑联系人' : '添加联系人'}</h2><button className="icon-button" type="button" aria-label="关闭" onClick={() => setContactFormOpen(false)}>×</button></div><label>备注名称<input autoFocus required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} maxLength={80} /></label><label>IPv4 地址<input required placeholder="例如 192.168.1.54" value={form.ip} onChange={event => setForm({ ...form, ip: event.target.value })} /></label><label>端口<input required type="number" min="1" max="65535" value={form.port} onChange={event => setForm({ ...form, port: event.target.value })} /></label><button className="primary full" type="submit">保存联系人</button></form></div>}
    {preview && <div className="modal-backdrop image-preview" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreview(undefined)}><button className="preview-close" aria-label="关闭预览" onClick={() => setPreview(undefined)}>×</button><img src={imageUrl(preview.id, false)} alt={preview.name} onClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); void window.desktop.imageContextMenu(preview.id).catch(showError); }} /><p>{preview.name} · 右键另存为 · Esc 关闭</p></div>}
  </main>;
}
