"use strict";
const $ = id => document.getElementById(id);
const socket = io();
const ui = Object.fromEntries([
  'joinScreen','mainScreen','joinForm','nameInput','joinError','slotText','usersNav','publicNav','privateNav','mapNav',
  'privateName','privateLive','mapOpen','backFromPrivate','backFromMap','chatScreen','chatPanel','mapScreen','chatStatus',
  'messages','messageForm','messageInput','photoButton','photoInput','goLiveButton','liveHint','mapVisibility','pinButton','pathButton','filtersButton','filtersPanel','closeFilters',
  'gritSlider','contrastSlider','hueSlider','saturationSlider','gritValue','contrastValue','hueValue','saturationValue','resetFilters','uiGrainOverlay','mapHelp',
  'mapCanvas','mapLines','mapPins','draftActions','draftCount','undoPoint','cancelDraft','finishPath',
  'annotationList','annotationCount','noteDialog','noteForm','noteInput','noteTitle','cancelNote','toast','connectionStatus',
  'photoDialog','photoPreview','photoCaption','closePhotoDialog','cancelPhoto','sendPhoto',
  'imageDialog','imageTitle','imageFull','closeImageDialog',
  'liveDialog','liveVideo','liveTitle','liveInfo','microphoneLabel','micEnabled','startLive','stopLive','closeLiveDialog'
].map(id => [id,$(id)]));

let myId = null;
let roster = [];
let target = 'public';
let onMap = false;
let messages = [];
let annotations = [];
let roomRequest = 0;
let toolMode = 'browse';
let draftPoints = [];
let pendingPoints = [];
let pendingType = 'pin';
let noteOpenId = null;
let toastTimeout;

// Screen-wide visual adjustments. They never alter map coordinates or what is shared with others.
const filterDefaults = Object.freeze({grit:0, contrast:100, hue:0, saturation:100});
const screenFilters = {...filterDefaults};
function clampFilter(name,value){
  const limits={grit:[0,100],contrast:[50,200],hue:[0,360],saturation:[0,200]};
  const [lo,hi]=limits[name];
  return Number.isFinite(Number(value)) ? Math.max(lo,Math.min(hi,Math.round(Number(value)))) : filterDefaults[name];
}
function applyScreenFilters(){
  // Apply the color filter to the document so chat, headers, popups, map and buttons all change.
  document.documentElement.style.filter=`contrast(${screenFilters.contrast}%) hue-rotate(${screenFilters.hue}deg) saturate(${screenFilters.saturation}%)`;
  // Noise is an overlay across the whole app, not just the map image.
  const gritOpacity=String(screenFilters.grit / 100 * 0.82);
  ui.uiGrainOverlay.style.opacity=gritOpacity;
  document.documentElement.style.setProperty('--global-grit-opacity',gritOpacity);
  for(const name of Object.keys(filterDefaults)){
    ui[name+'Slider'].value=String(screenFilters[name]);
    ui[name+'Value'].textContent=`${screenFilters[name]}${name==='hue'?'°':'%'}`;
  }
}
function saveScreenFilters(){
  try{localStorage.setItem('crimson-ui-filters',JSON.stringify(screenFilters));}catch(_error){}
}
function restoreScreenFilters(){
  try{
    const saved=JSON.parse(localStorage.getItem('crimson-ui-filters'));
    if(saved&&typeof saved==='object')for(const name of Object.keys(filterDefaults)){
      if(Object.prototype.hasOwnProperty.call(saved,name))screenFilters[name]=clampFilter(name,saved[name]);
    }
  }catch(_error){}
  applyScreenFilters();
}
function toggleFilters(open){
  ui.filtersPanel.classList.toggle('hidden',!open);
  ui.filtersButton.classList.toggle('active',open);
  ui.filtersButton.setAttribute('aria-expanded',String(open));
}

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => ui.toast.classList.add('hidden'), 3200);
}
function peer(id) { return roster.find(u => u.id === id); }
function roomId() { return target === 'public' ? 'public' : `dm:${[myId,target].sort().join(':')}`; }
function isCurrentRoom(room) { return Boolean(myId) && room === roomId(); }
function time(timestamp) { return new Date(timestamp).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}); }

function displayHeader() {
  const priv = target !== 'public';
  ui.mainScreen.classList.toggle('is-private',priv);
  ui.publicNav.classList.toggle('hidden',onMap || priv);
  ui.privateNav.classList.toggle('hidden',onMap || !priv);
  ui.mapNav.classList.toggle('hidden',!onMap);
  ui.mapOpen.classList.toggle('hidden',onMap);
  ui.chatScreen.classList.toggle('hidden',onMap);
  ui.mapScreen.classList.toggle('hidden',!onMap);
  ui.privateName.textContent = peer(target)?.name || 'name';
  const livePeer=priv?peer(target):null;
  ui.privateLive.classList.toggle('hidden',!livePeer?.live || onMap);
  ui.chatStatus.textContent = priv ? `private: ${peer(target)?.name||''}` : 'public chat';
  ui.mapVisibility.textContent = priv ? `private • ${peer(target)?.name||'name'}` : 'public • all three';
  if (myId) updateLiveControls();
}
function renderRoster() {
  ui.usersNav.replaceChildren();
  for (let i=0; i<3; i++) {
    const person=roster[i];
    const label = person ? person.name : 'name';
    const btn=create('button','person-tab'+(person?.id === myId ? ' is-me' : '')+(!person ? ' is-empty':''));
    btn.type='button';
    btn.append(create('span','person-name',label));
    if(person) {
      const indicator=create('span','person-subline'+(person.live?' live-indicator':''),person.live?'● LIVE · watch':'');
      btn.append(indicator);
      btn.title=person.live ? `${person.name} is LIVE. Tap LIVE to watch.` : person.id===myId ? 'Public chat' : `Private chat with ${person.name}`;
      btn.addEventListener('click',event=>{
        if(person.live && event.target.closest('.live-indicator')){openLiveFor(person.id);return;}
        openConversation(person.id === myId ? 'public' : person.id);
      });
    } else { btn.disabled=true;btn.title='Waiting for another person'; }
    ui.usersNav.append(btn);
  }
  if(target !== 'public' && !peer(target)) {
    target='public';onMap=false;resetTool();loadConversation();
  }
  if(!myId) ui.slotText.textContent=`${roster.length} / 3 people online`;
  displayHeader();
}
function renderMessages() {
  ui.messages.replaceChildren();
  if(messages.length===0) { ui.messages.append(create('div','empty-chat','chat')); return; }
  for(const msg of messages) {
    const own = msg.userId === myId;
    const row=create('div','message'+(own?' own':''));
    row.append(create('div','sender',own?'you':msg.name));
    if(msg.type==='photo' && typeof msg.photo==='string'){
      const bubble=create('div','bubble photo-bubble');
      const image=create('img','chat-photo');
      image.src=msg.photo;image.alt=`Photo from ${msg.name}`;image.loading='lazy';
      image.addEventListener('click',()=>openImage(msg.photo,msg.name));
      bubble.append(image);
      if(msg.caption) bubble.append(create('div','photo-caption',msg.caption));
      row.append(bubble);
    } else {
      row.append(create('div','bubble',msg.text));
    }
    row.append(create('div','time',time(msg.time)));
    ui.messages.append(row);
  }
  ui.messages.scrollTop=ui.messages.scrollHeight;
}
function resetTool() {
  toolMode='browse'; draftPoints=[];pendingPoints=[];
  paintDraft();
}
function loadConversation() {
  const request=++roomRequest;
  socket.emit('room:load',target,(result)=>{
    if(request!==roomRequest)return;
    if(!result?.ok){toast(result?.error||'Cannot open chat');return;}
    messages=result.messages||[];
    annotations=(result.annotations||[]).filter(a=>a.base==='reference');
    noteOpenId=null;
    renderMessages();renderMap();
  });
}
function openConversation(nextTarget) {
  if(!myId || (nextTarget!=='public' && !peer(nextTarget)))return;
  target=nextTarget;
  onMap=false;
  resetTool();
  displayHeader();
  loadConversation();
}
function enterMap() {
  onMap=true;
  resetTool();
  displayHeader();
  renderMap();
}
function leaveMap() {
  onMap=false;
  toggleFilters(false);
  resetTool();
  displayHeader();
}
function pointButton(p,text,draft=false,onClick) {
  const button=create('button','map-pin'+(draft?' draft':''),text);
  button.type='button';
  button.style.left=`${p.x*100}%`;
  button.style.top=`${p.y*100}%`;
  button.addEventListener('click',e=>{e.stopPropagation();if(onClick)onClick();});
  ui.mapPins.append(button);
  return button;
}
function drawPath(points,draft=false) {
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',points.map((p,index)=>`${index?'L':'M'}${(p.x*1000).toFixed(1)} ${(p.y*1000).toFixed(1)}`).join(' '));
  if(draft)path.setAttribute('class','draft');
  ui.mapLines.append(path);
}
function showNote(item) {
  noteOpenId = noteOpenId===item.id ? null : item.id;
  paintMap();
}
function paintMap() {
  ui.mapLines.replaceChildren();
  ui.mapPins.replaceChildren();
  for(const a of annotations) {
    if(a.kind==='path')drawPath(a.points);
    a.points.forEach((p,i)=>{
      pointButton(p,a.kind==='pin'?'●':String(i+1),false,()=>showNote(a));
    });
    if(noteOpenId===a.id) {
      const point=a.points[Math.floor((a.points.length-1)/2)];
      const tip=create('div','map-note');
      tip.textContent=a.note|| (a.kind==='pin'?'marked area':'saved path');
      tip.append(create('small','',`— ${a.name}`));
      tip.style.left=`${Math.min(78,Math.max(22,point.x*100))}%`;
      tip.style.top=`${Math.min(80,Math.max(7,point.y*100+4))}%`;
      tip.setAttribute('role','note');
      ui.mapPins.append(tip);
    }
  }
  paintDraft();
}
function paintDraft() {
  ui.pinButton.classList.toggle('active',toolMode==='pin');
  ui.pathButton.classList.toggle('active',toolMode==='path');
  ui.draftActions.classList.toggle('hidden',toolMode!=='path');
  ui.draftCount.textContent=`${draftPoints.length} point${draftPoints.length===1?'':'s'}`;
  ui.finishPath.disabled=draftPoints.length<2;
  ui.mapHelp.textContent=toolMode==='pin'?'tap the image to place a marker':toolMode==='path'?'tap to add points, then finish':'tap “mark area” or “path”';
  ui.mapPins.querySelectorAll('.draft').forEach(n=>n.remove());
  ui.mapLines.querySelectorAll('.draft').forEach(n=>n.remove());
  if(draftPoints.length>1)drawPath(draftPoints,true);
  draftPoints.forEach((p,i)=>pointButton(p,String(i+1),true));
}
function renderMap() {
  paintMap();
  ui.annotationCount.textContent=`${annotations.length} saved`;
  ui.annotationList.replaceChildren();
  if(!annotations.length) {
    ui.annotationList.append(create('span','annotation-empty','no markers or paths yet'));
    return;
  }
  for(const a of [...annotations].reverse()) {
    const row=create('div','annotation-row');
    const open=create('button','annotation-open',`${a.kind==='pin'?'●':'⌁'} ${a.note||'path'} · ${a.name}`);
    open.type='button';open.title='Show note on the map';
    open.addEventListener('click',()=>{noteOpenId=a.id;paintMap();});
    row.append(open);
    if(a.userId===myId){
      const del=create('button','annotation-remove','×');del.type='button';
      del.title='Delete your map item';
      del.addEventListener('click',()=>socket.emit('map:delete',{to:target,id:a.id},r=>{if(!r?.ok)toast(r?.error||'Could not delete');}));
      row.append(del);
    }
    ui.annotationList.append(row);
  }
}
function setTool(mode) {
  toolMode=toolMode===mode?'browse':mode;
  draftPoints=[];
  paintMap();
}
function canvasClicked(event) {
  if(toolMode==='browse' || event.target.closest('.map-pin') || event.target.closest('.map-note'))return;
  const bounds=ui.mapCanvas.getBoundingClientRect();
  const p={x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height))};
  if(toolMode==='pin'){
    pendingPoints=[p];pendingType='pin';ui.noteTitle.textContent='marker message';ui.noteInput.value='';
    ui.noteDialog.showModal();
  } else if (toolMode==='path') {
    if(draftPoints.length>=30){toast('Maximum 30 path points');return;}
    draftPoints.push(p);
    paintMap();
  }
}
function saveMapItem(){
  const points=[...pendingPoints],kind=pendingType,note=ui.noteInput.value.trim();
  ui.noteDialog.close();resetTool();
  socket.emit('map:add',{to:target,base:'reference',kind,points,note},result=>{
    if(!result?.ok)toast(result?.error||'Could not save map item');
  });
}

ui.joinForm.addEventListener('submit',e=>{
  e.preventDefault();
  if(!socket.connected){ui.joinError.textContent='Not connected yet. Try again.';return;}
  socket.emit('join',ui.nameInput.value,result=>{
    if(!result?.ok){ui.joinError.textContent=result?.error||'Cannot join';return;}
    myId=result.id;
    ui.joinScreen.classList.add('hidden');
    ui.mainScreen.classList.remove('hidden');
    if(!roster.some(u=>u.id===myId))roster=[...roster,{id:myId,name:result.name}];
    renderRoster();openConversation('public');
  });
});
ui.backFromPrivate.addEventListener('click',()=>openConversation('public'));
ui.mapOpen.addEventListener('click',enterMap);
ui.backFromMap.addEventListener('click',leaveMap);
ui.messageForm.addEventListener('submit',e=>{
  e.preventDefault();
  const text=ui.messageInput.value.trim();
  if(!text)return;
  socket.emit('message:send',{to:target,text},result=>{if(!result?.ok)toast(result?.error||'Message not sent');});
  ui.messageInput.value='';ui.messageInput.focus();
});
ui.pinButton.addEventListener('click',()=>{toggleFilters(false);setTool('pin');});
ui.pathButton.addEventListener('click',()=>{toggleFilters(false);setTool('path');});
ui.filtersButton.addEventListener('click',()=>toggleFilters(ui.filtersPanel.classList.contains('hidden')));
ui.closeFilters.addEventListener('click',()=>toggleFilters(false));
for(const name of Object.keys(filterDefaults)){
  ui[name+'Slider'].addEventListener('input',event=>{
    screenFilters[name]=clampFilter(name,event.target.value);
    applyScreenFilters();
    saveScreenFilters();
  });
}
ui.resetFilters.addEventListener('click',()=>{
  Object.assign(screenFilters,filterDefaults);
  applyScreenFilters();
  saveScreenFilters();
});
ui.mapCanvas.addEventListener('click',canvasClicked);
ui.undoPoint.addEventListener('click',()=>{draftPoints.pop();paintMap();});
ui.cancelDraft.addEventListener('click',resetTool);
ui.finishPath.addEventListener('click',()=>{
  if(draftPoints.length<2)return;
  pendingPoints=[...draftPoints];pendingType='path';
  ui.noteInput.value='';ui.noteTitle.textContent='path message';ui.noteDialog.showModal();
});
ui.noteForm.addEventListener('submit',e=>{e.preventDefault();saveMapItem();});
ui.cancelNote.addEventListener('click',()=>ui.noteDialog.close());
ui.noteDialog.addEventListener('close',()=>{pendingPoints=[];});

socket.on('connect',()=>{
  ui.connectionStatus.textContent='online';
  if(myId){
    // Socket IDs change after a reconnect; rejoining is required to restore access permissions.
    myId=null;roster=[];target='public';onMap=false;
    ui.mainScreen.classList.add('hidden');ui.joinScreen.classList.remove('hidden');
    ui.joinError.textContent='Connection restored. Enter your name again.';
  }
});
socket.on('disconnect',()=>{cleanupLiveOnDisconnect();ui.connectionStatus.textContent='offline';ui.joinError.textContent='Disconnected. Checking connection…';});
socket.on('users',list=>{
  roster=Array.isArray(list)?list:[];
  ui.slotText.textContent=`${roster.length} / 3 people online`;
  if(myId)renderRoster();
  updateLiveControls();
});
socket.on('message:new',({room,item})=>{
  if(isCurrentRoom(room)){
    if(!messages.some(m=>m.id===item.id)){messages.push(item);renderMessages();}
  }else if(myId&&room.startsWith('dm:')&&room.split(':').includes(myId))toast(`Private message from ${item.name}`);
});
socket.on('map:new',({room,item})=>{
  if(isCurrentRoom(room)){
    if(item.base==='reference'&&!annotations.some(a=>a.id===item.id)){
      annotations.push(item);renderMap();
    }
  }else if(myId&&room.startsWith('dm:')&&room.split(':').includes(myId))toast(`Private map item from ${item.name}`);
});
socket.on('map:removed',({room,id})=>{
  if(!isCurrentRoom(room))return;
  annotations=annotations.filter(a=>a.id!==id);
  if(noteOpenId===id)noteOpenId=null;
  renderMap();
});
restoreScreenFilters();
renderMap();


// --- In-browser photos, and peer-to-peer live camera broadcasts ---
const rtcConfig={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};
let pendingPhoto=null;
let ownMediaStream=null;
let isBroadcasting=false;
let requestedLiveId=null;
let watching=null; // {hostId,pc,pendingIce}
const liveViewers=new Map(); // viewerId -> {pc,pendingIce}

function openImage(dataUrl,name){
  ui.imageTitle.textContent=`photo • ${name}`;
  ui.imageFull.src=dataUrl;
  if(!ui.imageDialog.open)ui.imageDialog.showModal();
}
ui.closeImageDialog.addEventListener('click',()=>ui.imageDialog.close());
ui.imageDialog.addEventListener('close',()=>{ui.imageFull.removeAttribute('src');});

async function preparePhoto(file){
  if(!file || !file.type.startsWith('image/'))throw Error('Choose a photo file.');
  if(file.size>20*1024*1024)throw Error('Photo must be under 20 MB before resizing.');
  const source=URL.createObjectURL(file);
  try{
    const img=new Image();
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('The photo cannot be opened in this browser.'));img.src=source;});
    for(const [maxSide,quality] of [[1400,.78],[1150,.72],[950,.66],[800,.60],[650,.52]]){
      const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
      canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      const ctx=canvas.getContext('2d');
      if(!ctx)throw Error('This browser cannot process the photo.');
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const compressed=canvas.toDataURL('image/jpeg',quality);
      // Canvas conversion strips image metadata, including embedded photo location.
      if(compressed.startsWith('data:image/jpeg;base64,') && compressed.length<=880000)return compressed;
    }
    throw Error('Photo is still too large after resizing.');
  } finally {URL.revokeObjectURL(source);}
}
ui.photoButton.addEventListener('click',()=>{if(!myId){toast('Join the chat first');return;}ui.photoInput.click();});
ui.photoInput.addEventListener('change',async()=>{
  const file=ui.photoInput.files?.[0];ui.photoInput.value='';if(!file)return;
  ui.photoButton.disabled=true;
  try{
    pendingPhoto=await preparePhoto(file);
    ui.photoPreview.src=pendingPhoto;
    ui.photoCaption.value='';
    ui.photoDialog.showModal();
  }catch(error){toast(error.message||'Cannot open photo');}
  finally{ui.photoButton.disabled=false;}
});
function clearPhoto(){pendingPhoto=null;ui.photoPreview.removeAttribute('src');}
ui.closePhotoDialog.addEventListener('click',()=>ui.photoDialog.close());
ui.cancelPhoto.addEventListener('click',()=>ui.photoDialog.close());
ui.photoDialog.addEventListener('close',clearPhoto);
ui.sendPhoto.addEventListener('click',()=>{
  if(!pendingPhoto || !myId || !socket.connected)return;
  ui.sendPhoto.disabled=true;
  const photo=pendingPhoto,caption=ui.photoCaption.value.trim(),to=target;
  socket.timeout(20000).emit('message:photo',{to,photo,caption},(error,result)=>{
    ui.sendPhoto.disabled=false;
    if(error || !result?.ok){toast(result?.error||'Photo could not be sent');return;}
    ui.photoDialog.close();
  });
});

function updateLiveControls(){
  if(!ui.goLiveButton)return;
  ui.goLiveButton.textContent=isBroadcasting?'● LIVE • view / stop':'● go live';
  ui.goLiveButton.classList.toggle('broadcasting',isBroadcasting);
  ui.liveHint.textContent=isBroadcasting?'camera is broadcasting':'';
}
ui.goLiveButton.addEventListener('click',()=>openLiveFor(myId));
ui.privateLive.addEventListener('click',()=>{if(peer(target)?.live)openLiveFor(target);});

function showLiveDialog(title){
  ui.liveTitle.textContent=title;
  if(!ui.liveDialog.open)ui.liveDialog.showModal();
}
function videoDisplay(stream,muted){
  ui.liveVideo.srcObject=stream;
  ui.liveVideo.muted=muted;
  ui.liveVideo.play().catch(()=>{ui.liveInfo.textContent='Tap the video play button to start watching.';});
}
function clearVideo(){
  ui.liveVideo.pause();ui.liveVideo.srcObject=null;
}
function stopWatching(){
  if(!watching)return;
  const previous=watching;watching=null;
  try{previous.pc.close();}catch(_error){}
  if(socket.connected)socket.emit('live:leave',{hostId:previous.hostId});
  if(!isBroadcasting)clearVideo();
}
function stopLocalStream(){
  isBroadcasting=false;
  for(const {pc} of liveViewers.values())pc.close();
  liveViewers.clear();
  if(ownMediaStream){ownMediaStream.getTracks().forEach(track=>track.stop());ownMediaStream=null;}
  updateLiveControls();
  if(ui.liveDialog.open && requestedLiveId===myId)clearVideo();
}
function hideLiveDialog(){
  if(requestedLiveId!==myId)stopWatching();
  requestedLiveId=null;
  if(ui.liveDialog.open)ui.liveDialog.close();
  // Closing your own preview NEVER starts or stops broadcasting.
  clearVideo();
}
ui.closeLiveDialog.addEventListener('click',hideLiveDialog);
ui.liveDialog.addEventListener('cancel',event=>{event.preventDefault();hideLiveDialog();});
ui.liveDialog.addEventListener('close',()=>{
  if(requestedLiveId!==null){
    if(requestedLiveId!==myId)stopWatching();
    requestedLiveId=null;
    clearVideo();
  }
});
function openLiveFor(id){
  if(!id || !myId)return;
  if(requestedLiveId!==myId)stopWatching();
  requestedLiveId=id;
  const own=id===myId;
  ui.startLive.classList.toggle('hidden',!own || isBroadcasting);
  ui.stopLive.classList.toggle('hidden',!own || !isBroadcasting);
  ui.microphoneLabel.classList.toggle('hidden',!own || isBroadcasting);
  clearVideo();
  if(own){
    showLiveDialog('your live video');
    ui.liveInfo.textContent=isBroadcasting?'You are LIVE. Closing this window keeps your camera live until you press STOP.':'Camera and optional microphone begin only after you press START.';
    if(ownMediaStream)videoDisplay(ownMediaStream,true);
    return;
  }
  if(!peer(id)?.live){toast('This person is not live');requestedLiveId=null;return;}
  ui.startLive.classList.add('hidden');ui.stopLive.classList.add('hidden');ui.microphoneLabel.classList.add('hidden');
  showLiveDialog(`${peer(id).name} • LIVE`);
  ui.liveInfo.textContent='Connecting to the live broadcast…';
  watching={hostId:id,pc:null,pendingIce:[]};
  socket.timeout(10000).emit('live:watch',{hostId:id},(error,result)=>{
    if(requestedLiveId!==id)return;
    if(error||!result?.ok){ui.liveInfo.textContent=result?.error||'Unable to connect to video.';stopWatching();}
  });
}
ui.startLive.addEventListener('click',async()=>{
  if(isBroadcasting || !myId || !socket.connected)return;
  if(!navigator.mediaDevices?.getUserMedia){ui.liveInfo.textContent='Camera requires an HTTPS website and a supported browser.';return;}
  ui.startLive.disabled=true;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:960},height:{ideal:540}},audio:ui.micEnabled.checked});
    if(!myId||!socket.connected){stream.getTracks().forEach(t=>t.stop());throw Error('You are no longer connected.');}
    ownMediaStream=stream;
    const result=await new Promise(resolve=>socket.timeout(10000).emit('live:start',{},(error,response)=>resolve(error?{ok:false,error:'Server could not start broadcast'}:response)));
    if(!result?.ok){stream.getTracks().forEach(t=>t.stop());ownMediaStream=null;throw Error(result?.error||'Could not start video.');}
    isBroadcasting=true;
    videoDisplay(stream,true);
    ui.liveInfo.textContent='You are LIVE. Tap STOP to end the broadcast.';
    ui.startLive.classList.add('hidden');ui.stopLive.classList.remove('hidden');ui.microphoneLabel.classList.add('hidden');
    updateLiveControls();
    // End immediately if camera or screen capture is revoked by the browser.
    stream.getVideoTracks()[0]?.addEventListener('ended',()=>endBroadcast());
  }catch(error){ui.liveInfo.textContent=error.message||'Camera permission was denied.';}
  finally{ui.startLive.disabled=false;}
});
function endBroadcast(){
  if(socket.connected && myId)socket.emit('live:stop',{});
  stopLocalStream();
  ui.liveInfo.textContent='Broadcast stopped.';
  ui.stopLive.classList.add('hidden');ui.startLive.classList.remove('hidden');ui.microphoneLabel.classList.remove('hidden');
}
ui.stopLive.addEventListener('click',endBroadcast);

function createPeer(id,isHost){
  const pc=new RTCPeerConnection(rtcConfig);
  const state={pc,pendingIce:[]};
  pc.onicecandidate=event=>{
    if(event.candidate && socket.connected)socket.emit('live:signal',{to:id,signal:{type:'ice',candidate:event.candidate.toJSON()}});
  };
  pc.onconnectionstatechange=()=>{
    if(['failed','closed'].includes(pc.connectionState)){
      if(isHost){if(liveViewers.get(id)?.pc===pc)liveViewers.delete(id);}
      else if(watching?.pc===pc)ui.liveInfo.textContent='Video connection ended. Close and reopen the stream to retry.';
    }
  };
  return state;
}
async function applyPendingIce(state){
  for(const candidate of state.pendingIce.splice(0)){
    try{await state.pc.addIceCandidate(candidate);}catch(_error){}
  }
}
socket.on('live:viewer:joined',async({viewerId})=>{
  if(!isBroadcasting || !ownMediaStream || !peer(viewerId))return;
  const old=liveViewers.get(viewerId);
  if(old)old.pc.close();
  const state=createPeer(viewerId,true);
  liveViewers.set(viewerId,state);
  try{
    for(const track of ownMediaStream.getTracks())state.pc.addTrack(track,ownMediaStream);
    const offer=await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    socket.emit('live:signal',{to:viewerId,signal:{type:'offer',sdp:state.pc.localDescription.sdp}});
  }catch(_error){state.pc.close();liveViewers.delete(viewerId);}
});
socket.on('live:viewer:left',({viewerId})=>{
  const state=liveViewers.get(viewerId);
  if(state){state.pc.close();liveViewers.delete(viewerId);}
});
socket.on('live:signal',async({from,signal})=>{
  if(!signal || !from)return;
  try{
    if(signal.type==='offer' && watching?.hostId===from && requestedLiveId===from){
      if(watching.pc)watching.pc.close();
      const state=createPeer(from,false);
      state.pendingIce.push(...(watching.pendingIce||[]));
      watching=Object.assign({hostId:from},state);
      state.pc.ontrack=event=>{
        if(watching?.pc!==state.pc)return;
        videoDisplay(event.streams[0]||new MediaStream([event.track]),false);
        ui.liveInfo.textContent='Watching live video';
      };
      await state.pc.setRemoteDescription({type:'offer',sdp:signal.sdp});
      await applyPendingIce(state);
      const answer=await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      socket.emit('live:signal',{to:from,signal:{type:'answer',sdp:state.pc.localDescription.sdp}});
    } else if(signal.type==='answer' && liveViewers.has(from)){
      const state=liveViewers.get(from);
      await state.pc.setRemoteDescription({type:'answer',sdp:signal.sdp});
      await applyPendingIce(state);
    } else if(signal.type==='ice'){
      const state=watching?.hostId===from ? watching : liveViewers.get(from);
      if(!state || !signal.candidate)return;
      if(state.pc?.remoteDescription)await state.pc.addIceCandidate(signal.candidate);
      else state.pendingIce.push(signal.candidate);
    }
  }catch(error){
    if(watching?.hostId===from)ui.liveInfo.textContent='Unable to play this live video.';
  }
});
socket.on('live:ended',({hostId})=>{
  if(watching?.hostId===hostId){stopWatching();ui.liveInfo.textContent='Broadcast ended.';}
});
function cleanupLiveOnDisconnect(){
  stopWatching();
  stopLocalStream();
  hideLiveDialog();
}
updateLiveControls();
