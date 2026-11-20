// Finite diagnostic wire helpers. Node built-ins only; no service or credentials.
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import watchlist from '../deploy/market-worker/soak-watchlist.json' with {type:'json'};

export function assertPublicHttpTarget(url) {
  if(!(url instanceof URL)||url.origin!=='https://fapi.binance.com'||url.username||url.password||url.hash)throw Error('PUBLIC_HTTP_TARGET_REQUIRED');
  if(['/fapi/v1/ping','/fapi/v1/time','/fapi/v1/exchangeInfo'].includes(url.pathname)&&!url.search)return;
  const symbol=url.searchParams.get('symbol');
  if(!watchlist.symbols.includes(symbol))throw Error('PUBLIC_SYMBOL_REQUIRED');
  if(url.pathname==='/fapi/v1/ticker/24hr'&&url.search===`?symbol=${symbol}`)return;
  if(url.pathname==='/fapi/v1/depth'&&url.search===`?symbol=${symbol}&limit=100`)return;
  throw Error('PUBLIC_HTTP_TARGET_REQUIRED');
}
export function assertPublicSocketTarget(url) {
  const streams=watchlist.symbols.map(s=>s.toLowerCase());
  const allowed=['wss://fstream.binance.com/market/stream?streams=!ticker@arr/!markPrice@arr@1s',
    `wss://fstream.binance.com/market/stream?streams=${streams.map(s=>s+'@aggTrade').join('/')}`,
    `wss://fstream.binance.com/public/stream?streams=${streams.map(s=>s+'@depth@100ms').join('/')}`];
  if(!allowed.includes(String(url)))throw Error('PUBLIC_WS_TARGET_REQUIRED');
}

export function maskedControlFrame(opcode,payload=Buffer.alloc(0),mask=randomBytes(4)) {
  if(![8,10].includes(opcode)||payload.length>125||mask.length!==4)throw Error('INVALID_CLIENT_CONTROL');
  const out=Buffer.alloc(6+payload.length);out[0]=0x80|opcode;out[1]=0x80|payload.length;mask.copy(out,2);
  for(let i=0;i<payload.length;i++)out[i+6]=payload[i]^mask[i%4];return out;
}
export class PublicFrameDecoder {
  constructor({onText,onPing,onClose,maxBytes=4*1024*1024}) {
    this.onText=onText;this.onPing=onPing;this.onClose=onClose;this.maxBytes=maxBytes;
    this.buffer=Buffer.alloc(0);this.fragments=[];this.fragmentBytes=0;this.fragmented=false;this.closed=false;
  }
  push(chunk) {
    if(this.closed)return;
    if(this.buffer.length+chunk.length>this.maxBytes+65536)throw Error('WS_BUFFER_LIMIT');
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(!this.closed&&this.buffer.length>=2) {
      const first=this.buffer[0],second=this.buffer[1],fin=!!(first&128),opcode=first&15;
      if((first&112)||(second&128)||![0,1,8,9,10].includes(opcode))throw Error('WS_PROTOCOL_ERROR');
      let length=second&127,offset=2;
      if(length===126){if(this.buffer.length<4)return;length=this.buffer.readUInt16BE(2);offset=4;if(length<126)throw Error('WS_NONCANONICAL_LENGTH');}
      else if(length===127){if(this.buffer.length<10)return;const n=this.buffer.readBigUInt64BE(2);if(n>BigInt(this.maxBytes)||n<65536n)throw Error('WS_LENGTH_LIMIT');length=Number(n);offset=10;}
      if(length>this.maxBytes||(opcode>=8&&(!fin||length>125)))throw Error('WS_FRAME_LIMIT');
      if(this.buffer.length<offset+length)return;
      const payload=Buffer.from(this.buffer.subarray(offset,offset+length));this.buffer=this.buffer.subarray(offset+length);
      if(opcode===8){if(length===1)throw Error('WS_INVALID_CLOSE');this.closed=true;this.onClose();return;}
      if(opcode===9){this.onPing(payload);continue;}
      if(opcode===10)continue;
      if((opcode===0&&!this.fragmented)||(opcode===1&&this.fragmented))throw Error('WS_FRAGMENT_ORDER');
      this.fragments.push(payload);this.fragmentBytes+=length;if(this.fragmentBytes>this.maxBytes)throw Error('WS_MESSAGE_LIMIT');
      this.fragmented=!fin;
      if(fin){const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(this.fragments));this.fragments=[];this.fragmentBytes=0;this.onText(text);}
    }
  }
}
export function tlsEvidence(socket) {
  if(socket.authorized!==true)throw Error('TLS_NOT_AUTHORIZED');
  const cert=socket.getPeerCertificate();
  return {authorized:true,protocol:socket.getProtocol(),fingerprint256:cert.fingerprint256,validTo:cert.valid_to};
}
export async function publicHttpsGet(url,{signal,lookup,onEvidence,request=https.request,now=Date.now}) {
  assertPublicHttpTarget(url);
  const started=performance.now();
  return new Promise((resolve,reject)=>{
    let tls=null;
    const req=request(url,{method:'GET',agent:false,lookup,signal,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:16384,
      headers:{accept:'application/json','user-agent':'SmartExit-Finite-Public-Preflight/1'}},response=>{
      const status=response.statusCode;
      try {onEvidence({kind:'http',at:now(),path:url.pathname+url.search,status,rttMs:performance.now()-started,tls,
        retryAfter:response.headers['retry-after']??null,usedWeight:response.headers['x-mbx-used-weight-1m']??null});}
      catch(error){response.destroy();reject(error);return;}
      if(status!==200){response.destroy();reject(Error([403,418,429,451].includes(status)?`PROVIDER_DENIAL_${status}`:`PUBLIC_HTTP_${status}`));return;}
      if(!tls){response.destroy();reject(Error('TLS_EVIDENCE_MISSING'));return;}
      let bytes=0;const chunks=[];
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){response.destroy(Error('HTTP_BODY_LIMIT'));return;}chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(Error('INVALID_PUBLIC_JSON'));}});
    });
    req.on('socket',socket=>socket.once('secureConnect',()=>{try{tls=tlsEvidence(socket);}catch(error){req.destroy(error);}}));
    req.setTimeout(10_000,()=>req.destroy(Error('PUBLIC_HTTP_TIMEOUT')));req.on('error',reject);req.end();
  });
}
export async function openControlSocket(url,{signal,lookup,onText,onEvidence,onFailure,request=https.request,now=Date.now}) {
  assertPublicSocketTarget(url);
  const httpsUrl=new URL(url);httpsUrl.protocol='https:';
  const started=performance.now();
  const key=randomBytes(16).toString('base64'),expected=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  return new Promise((resolve,reject)=>{
    let socket,decoder,opened=false,closed=false,windowStart=started,sent=0;
    const stop=()=>{closed=true;if(decoder)decoder.closed=true;socket?.destroy();req.destroy();};
    const fail=error=>{if(closed)return;stop();if(opened)onFailure(error);else reject(error);};
    const req=request(httpsUrl,{method:'GET',agent:false,lookup,signal,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:16384,
      headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':key}},response=>{
        response.destroy();
        try {
          onEvidence({kind:'ws_denied',at:now(),status:response.statusCode,retryAfter:response.headers['retry-after']??null});
          fail(Error(`WS_UPGRADE_DENIED_${response.statusCode}`));
        } catch(error) {fail(error);}
      });
    req.setTimeout(10_000,()=>fail(Error('WS_HANDSHAKE_TIMEOUT')));req.on('error',fail);
    req.on('upgrade',(response,transport,head)=>{
      socket=transport;
      try {
        if(response.statusCode!==101||response.headers['sec-websocket-accept']!==expected||response.headers.upgrade?.toLowerCase()!=='websocket'||
          !response.headers.connection?.toLowerCase().split(',').map(x=>x.trim()).includes('upgrade')||response.headers['sec-websocket-extensions'])throw Error('INVALID_WS_UPGRADE');
        const tls=tlsEvidence(socket);req.setTimeout(0);socket.setTimeout(0);opened=true;
        onEvidence({kind:'ws_open',at:now(),url:String(url),tls,rttMs:performance.now()-started});
        decoder=new PublicFrameDecoder({onText,onClose:()=>fail(Error('PROVIDER_WS_CLOSED')),onPing:payload=>{
          const clock=performance.now();
          if(clock-windowStart>=1000){windowStart=clock;sent=0;}if(++sent>5)throw Error('WS_CONTROL_RATE_LIMIT');
          const hash=createHash('sha256').update(payload).digest('hex');onEvidence({kind:'server_ping',at:now(),hash,bytes:payload.length});
          socket.write(maskedControlFrame(10,payload),()=>{if(!closed)try{onEvidence({kind:'pong_written',at:now(),hash,bytes:payload.length});}catch(error){fail(error);}});
        }});
        socket.on('data',chunk=>{try{decoder.push(chunk);}catch(error){fail(error);}});
        socket.on('error',fail);socket.on('close',()=>{if(!closed)fail(Error('WS_DISCONNECTED'));});
        signal.addEventListener('abort',()=>fail(Error('PREFLIGHT_ABORTED')),{once:true});
        resolve({close:stop});if(head.length)decoder.push(head);
      }catch(error){fail(error);}
    });
    req.end();
  });
}
