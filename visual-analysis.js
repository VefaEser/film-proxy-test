// Test-only multimodal film-still analysis. Keeps visual evidence separate from text LLM fields.
import { putVisualProfile } from "./db.js";

const MAX_SAMPLES = 20;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const GROQ_VISION_MODEL = "qwen/qwen3.8-27b"; // Groq vision endpoint currently documents max 3 images/request.
const PROMPT = `Film sinematografisi ve görüntü dili uzmanısın. Ekli görseller aynı filmin seçilmiş SAHNE kareleridir.
YALNIZCA karelerde doğrudan gözlenen kanıtları sınıflandır. Poster, logo, afiş, portre veya sahne olmadığı açık görselleri geçersiz say.
Her geçerli kare için: day_night = day|night|twilight|unknown; indoor_outdoor = indoor|outdoor|mixed|unknown; color_mode = color|black_white|sepia|unknown.
Kamera/görüntü dili: camera_angles, framing, composition, perspective, depth_of_field, lighting, palette, visual_observations.
Teknik stil filtresindeki slug'lar yalnızca kanıt güçlü ve birden fazla karede tekrar ediyorsa ver: handheld, static_camera, tracking_shot, steadicam, crane_shot, aerial_shot, zoom, pan_tilt.
ÖNEMLİ: Tek fotoğraf/kare kamera hareketini kanıtlamaz. Ardışık kare veya video hareket kanıtı yoksa handheld/tracking_shot/steadicam/zoom/pan_tilt/static_camera değerlerini çıkarma. Aerial_shot yalnızca açıkça havadan çekim perspektifi görülüyorsa kullanılabilir. Kamera açıları/çekim ölçekleri gibi hareket olmayan gözlemleri ayrıca açıklayıcı metinde belirt.
Oranları yalnızca geçerli ve bilinmeyen olmayan karelerden hesapla; bilinmeyeni paydaya katma. day_ratio + night_ratio + twilight_ratio = 100 olmak zorunda değil (twilight ayrı). indoor_ratio yalnızca indoor/outdoor olarak sınıflanabilen karelerden hesaplanır. color_ratio = renkli kare yüzdesi; black_white_ratio ayrı.
Yalnızca JSON: {"summary":"...","valid_sample_count":0,"coverage":0,"day_ratio":null,"night_ratio":null,"twilight_ratio":null,"indoor_ratio":null,"outdoor_ratio":null,"color_ratio":null,"black_white_ratio":null,"color_style": ["black_white|color|mostly_color|mostly_bw|blue_filter|yellow_filter|selective_color|colorized|limited_palette|sepia|mono_tint|bw_red_accent|mixed_bw_color" içinden uygun sluglar],"technical_style":[],"camera_angles":[],"framing":[],"composition":[],"perspective":[],"depth_of_field":[],"lighting":[],"color_palette":[],"visual_style":"...","confidence":0.0,"per_image":[{"source_id":"...","valid_scene":true,"day_night":"unknown","indoor_outdoor":"unknown","color_mode":"unknown","technical_style":[],"observations":"..."}]}`;

function toBase64(bytes) { let binary=""; for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length))); return btoa(binary); }
function parseJson(text) { const raw=String(text||"").trim(); try{return JSON.parse(raw);}catch{} const a=raw.indexOf("{"); const b=raw.lastIndexOf("}"); if(a>=0&&b>a)return JSON.parse(raw.slice(a,b+1)); throw new Error("Görsel model geçerli JSON döndürmedi."); }
function outputText(data) {
  if (data?.candidates?.[0]?.content?.parts) return data.candidates[0].content.parts.map(x=>x.text||"").join("\n");
  if (typeof data?.output_text === "string") return data.output_text;
  const parts = data?.output?.flatMap?.(x=>x.content||[]) || data?.steps?.flatMap?.(x=>x.content||[]) || [];
  return parts.map(x=>x.text||"").join("\n");
}
async function fetchImage(sample, signal) {
  const url=new URL(sample.source_url); const h=url.hostname.toLowerCase();
  const ok=h==="image.tmdb.org"||h==="upload.wikimedia.org"||h.endsWith(".wikimedia.org")||h==="m.media-amazon.com"||h.endsWith(".media-amazon.com")||h==="crawlora.net"||h.endsWith(".crawlora.net")||h.endsWith(".imdb.com");
  if(url.protocol!=="https:"||!ok) throw new Error("Güvenilmeyen görsel kaynağı reddedildi.");
  const res=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)].filter(Boolean))});
  if(!res.ok) throw new Error(`Görsel kaynağı HTTP ${res.status} döndürdü.`);
  const mime=(res.headers.get("content-type")||"image/jpeg").split(";")[0].toLowerCase();
  if(!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error("Desteklenmeyen görsel biçimi.");
  const declared=Number(res.headers.get("content-length")||0); if(declared>MAX_IMAGE_BYTES) throw new Error("Görsel boyutu sınırı aşıldı.");
  const bytes=new Uint8Array(await res.arrayBuffer()); if(!bytes.length||bytes.length>MAX_IMAGE_BYTES) throw new Error("Görsel boyutu sınırı aşıldı.");
  return {mimeType:mime,bytes};
}
function makePromptParts(used, images) {
  const out=[{text:PROMPT}];
  used.forEach((s,i)=>{out.push({text:`KARE ${i+1}; source_id=${String(s.source_id||s.id)}; source=${String(s.source_name||"unknown")}`});out.push({inlineData:{mimeType:images[i].mimeType,data:toBase64(images[i].bytes)}});});
  return out;
}
function geminiInput(parts) { return parts.map(p=>p.text!==undefined?{type:"text",text:p.text}:{type:"image",mime_type:p.inlineData.mimeType,data:p.inlineData.data}); }
async function callGeminiMethod(model,key,method,parts,signal) {
  const headers={"Content-Type":"application/json","x-goog-api-key":key,"Api-Revision":"2026-05-20"};
  if(method==="Interactions") {
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/interactions",{method:"POST",headers,body:JSON.stringify({model,input:geminiInput(parts)}),signal:AbortSignal.any([signal,AbortSignal.timeout(25000)].filter(Boolean))});
    const t=await r.text(); if(!r.ok)throw new Error(`Interactions HTTP ${r.status}: ${t.slice(0,180)}`); const d=JSON.parse(t); const text=d.output_text||d.output?.flatMap?.(x=>x.content||[]).map(x=>x.text||"").join("\n")||""; if(!text)throw new Error("Interactions boş yanıt döndürdü"); return {text,data:d};
  }
  const streaming=method==="StreamGenerateContent";
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${streaming?"streamGenerateContent?alt=sse":"generateContent"}`;
  const body={contents:[{role:"user",parts}],generationConfig:{temperature:0.1,responseMimeType:"application/json",maxOutputTokens:2600}};
  const r=await fetch(url,{method:"POST",headers,body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(25000)].filter(Boolean))});
  if(!r.ok)throw new Error(`${method} HTTP ${r.status}: ${(await r.text()).slice(0,180)}`);
  if(!streaming){const d=await r.json();const text=outputText(d);if(!text)throw new Error("GenerateContent boş yanıt döndürdü");return {text,data:d};}
  if(!r.body)throw new Error("StreamGenerateContent boş stream gövdesi");
  const reader=r.body.getReader(),decoder=new TextDecoder();let buffer="",text="",meta={};
  const consume=raw=>{const payload=raw.split("\n").filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trim()).join("\n");if(!payload||payload==="[DONE]")return;const d=JSON.parse(payload);text+=outputText(d);meta=d;};
  try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let match;while((match=/\r?\n\r?\n/.exec(buffer))){consume(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);}if(done)break;}if(buffer.trim())consume(buffer);}finally{try{reader.releaseLock();}catch{}}
  if(!text.trim())throw new Error("StreamGenerateContent metin üretmedi");return {text,data:meta};
}
async function callGemini(env,parts,signal) {
  const keys=[env.GEMINI_API_KEY_1,env.GEMINI_API_KEY_2,env.GEMINI_API_KEY_3,env.GEMINI_API_KEY].filter(Boolean);
  if(!keys.length)throw new Error("Gemini görsel analiz anahtarı tanımlı değil.");
  const preferred=String(env.GEMINI_VISUAL_MODEL||env.GEMINI_MODEL||"").trim();
  const models=[...new Set([preferred,...GEMINI_MODELS].filter(Boolean))]; const errors=[];
  const deadline=Date.now()+160000; let attempts=0;
  for(const model of models) for(let ki=0;ki<keys.length;ki++) {
    const methods=["Interactions","GenerateContent","StreamGenerateContent"];
    for(const method of methods) {
      if(attempts>=18 || Date.now()>=deadline) break;
      attempts++;
      try { const result=await callGeminiMethod(model,keys[ki],method,parts,signal); return {analysis:parseJson(result.text),provider:"gemini",model,method,keySlot:ki+1,usage:result.data?.usageMetadata||null}; }
      catch(e){if(signal?.aborted)throw e;errors.push(`${model}/${method}/key${ki+1}: ${String(e.message||e).slice(0,100)}`);}
    }
    if(attempts>=18 || Date.now()>=deadline) break;
  }
  throw new Error(`Gemini görsel yöntem/model zinciri başarısız: ${errors.slice(-8).join(" | ")}`);
}
async function callGroq(env,used,images,signal) {
  const keys=[env.GROQ_API_KEY_1,env.GROQ_API_KEY_2,env.GROQ_API_KEY_3].filter(Boolean);
  if(!keys.length)throw new Error("Groq görsel analiz anahtarı tanımlı değil.");
  const merged={per_image:[],errors:[]}; let chosenKey=1;
  // Groq Qwen vision model accepts at most three images per request. Analyze chunks, then merge frame-level observations.
  for(let start=0;start<used.length;start+=3) {
    const chunk=used.slice(start,start+3),imgs=images.slice(start,start+3);let ok=null,last=null;
    const prompt=[{type:"text",text:PROMPT+" Bu istekte yalnızca verilen kareleri değerlendir. Oranları bu alt küme için hesapla; her per_image kaydında verilen source_id değerini aynen kullan."}];
    chunk.forEach((s,i)=>{prompt.push({type:"text",text:`source_id=${String(s.source_id||s.id)}`});prompt.push({type:"image_url",image_url:{url:`data:${imgs[i].mimeType};base64,${toBase64(imgs[i].bytes)}`}});});
    for(let k=0;k<keys.length&&!ok;k++)try{
      const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${keys[k]}`},body:JSON.stringify({model:GROQ_VISION_MODEL,messages:[{role:"user",content:prompt}],temperature:0.1,max_completion_tokens:2200}),signal:AbortSignal.any([signal,AbortSignal.timeout(25000)].filter(Boolean))});
      const t=await r.text();if(!r.ok)throw new Error(`Groq HTTP ${r.status}: ${t.slice(0,180)}`);const d=JSON.parse(t);const text=d.choices?.[0]?.message?.content||"";if(!text)throw new Error("Groq boş yanıt döndürdü");ok={analysis:parseJson(text),usage:d.usage};chosenKey=k+1;
    }catch(e){last=e;}
    if(!ok)throw last||new Error("Groq görsel analiz başarısız");
    merged.per_image.push(...(Array.isArray(ok.analysis.per_image)?ok.analysis.per_image:[]));
  }
  const valid=merged.per_image.filter(x=>x&&x.valid_scene!==false); const count=(fn)=>valid.filter(fn).length; const pct=(n,d)=>d?Math.round(n*100/d):null;
  const day=count(x=>x.day_night==="day"),night=count(x=>x.day_night==="night"),tw=count(x=>x.day_night==="twilight"),dn=day+night+tw;
  const inside=count(x=>x.indoor_outdoor==="indoor"),outside=count(x=>x.indoor_outdoor==="outdoor"),io=inside+outside;
  const color=count(x=>x.color_mode==="color"),bw=count(x=>x.color_mode==="black_white"||x.color_mode==="sepia"),cn=color+bw;
  const tags=[...new Set(valid.flatMap(x=>Array.isArray(x.technical_style)?x.technical_style:[]))];
  return {analysis:{valid_sample_count:valid.length,coverage:valid.length/used.length,day_ratio:pct(day,dn),night_ratio:pct(night,dn),twilight_ratio:pct(tw,dn),indoor_ratio:pct(inside,io),outdoor_ratio:pct(outside,io),color_ratio:pct(color,cn),black_white_ratio:pct(bw,cn),technical_style:tags,color_style:cn ? (bw===cn?["black_white"]:color===cn?["color"]:color/cn>=.65?["mostly_color"]:color/cn<=.35?["mostly_bw"]:["mixed_bw_color"]) : [],per_image:merged.per_image,confidence:Math.min(.8,valid.length/Math.max(1,used.length))},provider:"groq",model:GROQ_VISION_MODEL,method:"chat.completions-vision-batched",keySlot:chosenKey,usage:null};
}
function normalizeAnalysis(a,used) {
  const n=x=>Number.isFinite(Number(x))&&x!==null?Math.max(0,Math.min(100,Math.round(Number(x)))):null;
  const allowed=new Set(["handheld","static_camera","tracking_shot","steadicam","crane_shot","aerial_shot","zoom","pan_tilt"]);
  const colorAllowed=new Set(["black_white","color","mostly_color","mostly_bw","blue_filter","yellow_filter","selective_color","colorized","limited_palette","sepia","mono_tint","bw_red_accent","mixed_bw_color"]);
  const valid=Array.isArray(a.per_image)?a.per_image.filter(x=>x&&x.valid_scene!==false):[];
  // A single still can support an aerial vantage, but cannot prove camera movement or a locked-off camera.
  const tags=[...new Set((Array.isArray(a.technical_style)?a.technical_style:[]).filter(x=>x==="aerial_shot" && allowed.has(x)))];
  const conf=Math.max(0,Math.min(1,Number(a.confidence)||0));
  return {summary:String(a.summary||""),validSampleCount:Number(a.valid_sample_count)||valid.length,coverage:Math.max(0,Math.min(1,Number(a.coverage)||valid.length/Math.max(1,used.length))),dayRatio:n(a.day_ratio),nightRatio:n(a.night_ratio),twilightRatio:n(a.twilight_ratio),indoorRatio:n(a.indoor_ratio),outdoorRatio:n(a.outdoor_ratio),colorRatio:n(a.color_ratio),blackWhiteRatio:n(a.black_white_ratio),colorStyle:(Array.isArray(a.color_style)?a.color_style:[]).filter(x=>colorAllowed.has(x)),technicalStyle:tags,cameraAngles:a.camera_angles||[],framing:a.framing||[],composition:a.composition||[],perspective:a.perspective||[],depthOfField:a.depth_of_field||[],lighting:a.lighting||[],colorPalette:a.color_palette||[],visualStyle:a.visual_style||"",confidence:conf,perImage:valid};
}
export async function analyzeVisualMovie(env,movieId,signal) {
  if(!env.DB)throw new Error("Test Turso bağlantısı bulunamadı.");
  const {results}=await env.DB.prepare(`SELECT id,source_url,source_id,source_name,license,attribution FROM visual_samples WHERE movie_id=? ORDER BY id ASC LIMIT ?`).bind(String(movieId),MAX_SAMPLES).all();
  const samples=results||[];if(!samples.length)throw Object.assign(new Error("Önce /images üzerinden analiz edilecek görsel listesi oluşturulmalı."),{status:404});
  const used=[],images=[];let total=0;
  for(const s of samples){try{const im=await fetchImage(s,signal);if(total+im.bytes.length>MAX_TOTAL_BYTES)break;total+=im.bytes.length;used.push(s);images.push(im);}catch(e){console.warn("[visual-analysis] sample skipped",s.id,e.message);}}
  if(!used.length)throw new Error("Analiz için erişilebilir, uygun formatta sahne görseli bulunamadı.");
  const parts=makePromptParts(used,images);let result,lastError;
  try{result=await callGemini(env,parts,signal);}catch(e){lastError=e;console.warn("[visual-analysis] Gemini zinciri tükendi; Groq vision yedeği deneniyor:",e.message);}
  if(!result){try{result=await callGroq(env,used,images,signal);}catch(e){throw new Error(`Gemini ve Groq görsel analizleri başarısız. Gemini: ${lastError?.message||"yok"}. Groq: ${e.message}`);}}
  const a=normalizeAnalysis(result.analysis,used);const now=Math.floor(Date.now()/1000);const common={confidence:a.confidence,sampleCount:a.validSampleCount,sourceType:"still_frame",modelName:`${result.provider}/${result.model}`,modelVersion:`${result.method}`,analyzedAt:now};
  const fields={
    cinematography:{value:{summary:a.summary,visualStyle:a.visualStyle,cameraAngles:a.cameraAngles,framing:a.framing,composition:a.composition,perspective:a.perspective,depthOfField:a.depthOfField,lighting:a.lighting,colorPalette:a.colorPalette,perImage:a.perImage},...common},
    day_ratio:{value:a.dayRatio,...common},night_ratio:{value:a.nightRatio,...common},indoor_ratio:{value:a.indoorRatio,...common},outdoor_ratio:{value:a.outdoorRatio,...common},color_ratio:{value:a.colorRatio,...common},black_white_ratio:{value:a.blackWhiteRatio,...common},color_style:{value:a.colorStyle,...common},technical_style:{value:a.technicalStyle,...common},
    visual_analysis_meta:{value:{provider:result.provider,model:result.model,method:result.method,keySlot:result.keySlot,sampleCount:used.length,validSampleCount:a.validSampleCount,coverage:a.coverage,sourceIds:used.map(x=>String(x.source_id||x.id)),licenseTracked:true},...common}
  };
  await putVisualProfile(env,String(movieId),fields,{schemaVersion:3,status:"complete"});
  return {ok:true,movieId:String(movieId),analyzedSamples:used.length,validSamples:a.validSampleCount,coverage:a.coverage,provider:result.provider,model:result.model,method:result.method,usage:result.usage||null,analysis:a};
}
