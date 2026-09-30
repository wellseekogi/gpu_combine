"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Download, FileCheck2, MessageSquare, Play, RefreshCw, Upload, Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Tabs } from "radix-ui";
import { parseModelContract } from "@/lib/relay/setup.mjs";
import "./participant-chat.css";

type Model = { id?: string; name?: string; digest: string; runtime: string; template: string; context: number };
type Credential = { version: 1; kind: "relay-member-account"; coordinator: string; id: string; token: string; name: string };
type Config = { version: number; coordinator: string; pool: string; node: string; nodeName?: string; token: string; context: number; model: Model };
type NodeInfo = { id: string; name: string; model: string; context?: number; vram: number; status: string; connected: boolean; busy?: boolean; mine: boolean; capabilities?: string[]; revoked?: boolean; earned?: number; completed?: number };
type ModelArtifact = { id: string; name: string; digest: string; size: number };
type ChatMessage = { role: string; content: string };
type Job = { id: string; kind?: string; modelId?: string; model?: { context?: number }; modelArtifact?: ModelArtifact; allowedNodes?: string[]; title: string; status: string; rentalStage?: string; spent: number; reserved: number; archived?: boolean; messages?: ChatMessage[]; tasks: { id: string; status?: string; stage?: string; quality: string; messages?: ChatMessage[]; output?: string; finishReason?: string; reason?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number; billable_tokens?: number }; charge?: number; items?: { field: string; value: string | null; quote?: string }[] }[] };
type Entry = { id: string; type: string; at: number; amount: number; from?: string; to?: string; provider?: number };
type Snapshot = { id: string; name: string; account: string; credits: { balance: number; available: number; reserved: number }; state: { books: { live: { nodes: NodeInfo[]; models: Model[]; jobs: Job[]; ledger: Entry[] } } } };
type RequestSlot = { fingerprint: string; id: string; token?: string };
type Pairing = { code: string; expiresAt: number; status: "pending" | "paired" };
const emptySlot = () => ({ current: null as RequestSlot | null });
const amount = (value: number) => new Intl.NumberFormat("ko-KR").format(value || 0);
const jobStatus: Record<string, string> = { queued: "배정 대기", running: "실행 중", completed: "완료", partial: "일부 완료", cancelled: "취소" };
type MemberTab = "provide" | "use" | "history";
const runtimeOnlyContract = (model: Model | null) => !!model && /^0{64}$/.test(model.digest) && /^0{64}$/.test(model.template);

function ChatResult({ job, modelName, busy, onCancel }: { job: Job; modelName?: string; busy: boolean; onCancel: () => void }) {
  const pending = ["queued", "running"].includes(job.status);
  const output = job.tasks.filter(task => task.output);
  const prompt = job.messages?.findLast(message => message.role === "user")?.content;
  const stage = job.tasks.find(task => task.status === "leased")?.stage;
  const runningLabel = stage === "downloading" ? "선택한 GPU의 PC로 업로드한 모델을 전송하고 있습니다." : stage === "loading" ? "다른 사람의 GPU에 내 모델을 올리고 있습니다." : "다른 사람의 GPU에서 내 모델로 답변을 생성하고 있습니다.";
  return <article className="member-job member-chat-result" data-testid={"member-chat-" + job.id}>
    <div className="member-section-head"><b>{job.title}</b><span className="member-chat-state" data-status={job.status}>{job.status === "partial" ? "생성 실패" : jobStatus[job.status] || job.status}</span></div>
    <p>{job.modelArtifact?.name || modelName || "내 LLM"} · 사용 {job.spent} CR · 예약 {job.reserved} CR</p>
    {prompt && <details className="member-chat-prompt"><summary>보낸 프롬프트</summary><p>{prompt}</p></details>}
    <div aria-live="polite" aria-atomic="false">
      {job.status === "queued" && <p className="member-chat-progress">선택한 GPU가 요청을 받을 때까지 기다리고 있습니다. 연결 상태에 따라 대기할 수 있습니다.</p>}
      {job.status === "running" && <p className="member-chat-progress"><RefreshCw size={16} /> {runningLabel} 완료되면 답변이 표시됩니다.</p>}
      {output.map(task => <div key={task.id} className="member-chat-answer"><span><MessageSquare size={15} /> LLM 답변</span><div>{task.output}</div>{task.finishReason === "length" && <p className="small">최대 출력 토큰에 도달해 답변이 끝났습니다.</p>}</div>)}
      {!pending && !output.length && <p>{job.status === "cancelled" ? "요청이 취소되었습니다. 사용하지 않은 예약 크레딧은 반환됩니다." : job.tasks.find(task => task.reason)?.reason || "생성된 답변이 없습니다. GPU 상태를 확인하고 다시 실행하세요."}</p>}
    </div>
    {pending && <button className="secondary" disabled={busy} onClick={onCancel}>작업 취소</button>}
  </article>;
}

function RentalTerminal({ job, busy, prompt, setPrompt, maxTokens, setMaxTokens, onSend, onReset, onEnd, onBack }: {
  job: Job | undefined; busy: boolean; prompt: string; setPrompt: (value: string) => void; maxTokens: number; setMaxTokens: (value: number) => void;
  onSend: (event: React.FormEvent) => void; onReset: () => void; onEnd: () => void; onBack: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const running = job?.status === "running";
  const ready = running && job.rentalStage === "ready";
  const pending = job?.tasks.findLast(task => ["ready", "leased"].includes(task.status ?? ""));
  const pendingPrompt = pending?.messages?.findLast(message => message.role === "user")?.content;
  const lastTurn = job?.tasks.findLast(task => task.status === "settled" && task.output);
  const maxOutput = Math.min(4096, (job?.model?.context ?? 4096) - 1);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [job?.messages?.length, pendingPrompt, job?.rentalStage]);
  return <section className="member-terminal" data-testid="member-rental-terminal" aria-label="LLM 터미널">
    <div className="member-terminal-head"><div><h2>LLM 터미널</h2><p>{job?.modelArtifact?.name || "모델 준비 중"} · {job?.title || "GPU 임대"}</p></div><span className="member-chat-state" data-status={job?.rentalStage || "loading"}>{job && !running ? "임대 종료" : !job || job.rentalStage === "loading" ? "모델 로딩 중" : job.rentalStage === "ready" ? "GPU 사용 중" : job.rentalStage === "failed" ? "실행 실패" : "임대 종료"}</span></div>
    <div className="member-terminal-meter"><span>사용 요금 <b>{amount(job?.spent ?? 0)} CR</b></span><span>예약 <b>{amount(job?.reserved ?? 0)} CR</b></span>{lastTurn?.usage && <span>최근 연산 <b>{amount(lastTurn.usage.billable_tokens ?? lastTurn.usage.total_tokens ?? 0)} 토큰 · {amount(lastTurn.charge ?? 0)} CR</b></span>}</div>
    <div className="member-terminal-log" role="log" aria-label="LLM 대화 기록" ref={log}>
      {!job?.messages?.length && !pendingPrompt && <p className="member-terminal-empty">{job?.rentalStage === "loading" || !job ? "선택한 GPU로 모델을 전송하고 있습니다. 준비되면 바로 대화할 수 있습니다." : "모델이 준비되었습니다. 아래에 메시지를 입력하세요."}</p>}
      {job?.messages?.map((message, index) => <article className="member-terminal-message" data-role={message.role} key={index}><b>{message.role === "user" ? "나" : message.role === "assistant" ? "LLM" : "시스템"}</b><p>{message.content}</p></article>)}
      {pendingPrompt && <article className="member-terminal-message" data-role="user"><b>나</b><p>{pendingPrompt}</p></article>}
      {pending && <p className="member-chat-progress" role="status"><RefreshCw size={16} /> {pending.stage === "downloading" ? "모델을 전송하고 있습니다." : pending.stage === "loading" || !pendingPrompt ? "모델을 GPU에 적재하고 있습니다." : "LLM이 답변을 생성하고 있습니다."}</p>}
      {job?.rentalStage === "failed" && <p className="danger" role="alert">{job.tasks.findLast(task => task.reason)?.reason || "모델 실행에 실패했습니다. GPU 상태와 모델 호환성을 확인하세요."}</p>}
    </div>
    {running && <div className="member-terminal-actions"><button className="secondary" type="button" disabled={busy || !ready || !!pending} onClick={onReset}>새 대화</button><button className="secondary" type="button" disabled={busy} onClick={onEnd}>GPU 임대 종료</button></div>}
    {running && <form className="member-terminal-form" onSubmit={onSend}><label htmlFor="member-terminal-prompt">메시지</label><textarea id="member-terminal-prompt" aria-label="LLM 메시지" rows={3} maxLength={16000} value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy || !ready || !!pending} placeholder={ready ? "LLM에게 물어보세요" : "모델이 준비되면 입력할 수 있습니다"} /><div><label>최대 출력 토큰<input type="number" min={1} max={maxOutput} step={1} value={maxTokens} onChange={event => setMaxTokens(Number(event.target.value))} disabled={busy || !ready || !!pending} /></label><button className="primary" disabled={busy || !ready || !!pending || !prompt.trim()}>전송</button></div></form>}
    {!running && <button className="secondary" onClick={onBack}>다른 GPU 빌리기</button>}
  </section>;
}

function requestIdentity(ref: { current: RequestSlot | null }, input: unknown, node = false) {
  const fingerprint = JSON.stringify(input);
  if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, id: crypto.randomUUID(), ...(node ? { token: crypto.randomUUID() + crypto.randomUUID() } : {}) };
  return ref.current;
}
function save(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function api(path: string, credential?: Credential | null, body?: unknown, method?: "DELETE") {
  const response = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"), cache: "no-store",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(credential ? { "X-Relay-Member": credential.id, Authorization: "Bearer " + credential.token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(error => { throw error instanceof TypeError ? Error("서버에 연결할 수 없습니다. 서버 실행 상태와 네트워크를 확인하세요.") : error; });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "요청을 처리하지 못했습니다. 다시 시도하세요.");
  return result;
}
function origin(value: unknown) {
  if (typeof value !== "string") throw Error("서비스 주소를 확인하세요.");
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("서비스 주소를 확인하세요.");
  return url.origin;
}
async function jsonFile(file: File) {
  if (file.size > 65536) throw Error("64KB 이하의 Relay JSON 파일을 선택하세요.");
  const value = JSON.parse(await file.text());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Relay JSON 파일을 선택하세요.");
  return value;
}

export default function ParticipantPanel({ open, onOpenChange, initialTab = "provide" }: { open: boolean; onOpenChange: (open: boolean) => void; initialTab?: MemberTab }) {
  const [server, setServer] = useState("");
  const [signupCredits, setSignupCredits] = useState(100);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<MemberTab>(initialTab);
  const [contract, setContract] = useState<Model | null>(null);
  const [contractName, setContractName] = useState("");
  const [contractLoading, setContractLoading] = useState(false);
  const [deviceError, setDeviceError] = useState("");
  const [pcName, setPcName] = useState("");
  const [modelName, setModelName] = useState("");
  const [vram, setVram] = useState(4);
  const [config, setConfig] = useState<Config | null>(null);
  const [configSaved, setConfigSaved] = useState(false);
  const [deviceForm, setDeviceForm] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [selectedNode, setSelectedNode] = useState("");
  const [rentalId, setRentalId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ModelArtifact[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [contextSize, setContextSize] = useState(4096);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState(512);
  const [publicData, setPublicData] = useState(false);
  const signup = useRef<RequestSlot | null>(null);
  const deviceRequest = useRef<RequestSlot | null>(null);
  const jobRequest = useRef<RequestSlot | null>(null);
  const actionRequests = useRef<Record<string, ReturnType<typeof emptySlot>>>({});
  const importInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const configInput = useRef<HTMLInputElement>(null);
  const artifactInput = useRef<HTMLInputElement>(null);
  const uploadRequest = useRef<XMLHttpRequest | null>(null);
  const deviceFeedback = useRef<HTMLParagraphElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const modelRead = useRef(0);
  const lock = useRef(false);
  const epoch = useRef(0);

  useEffect(() => {
    if (deviceError) deviceFeedback.current?.focus();
  }, [deviceError]);

  useEffect(() => {
    if (error) { feedback.current?.focus(); feedback.current?.scrollIntoView({ block: "center" }); }
  }, [error]);

  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    void api("/api/participation/info").then(value => { if (!stopped) { setServer(origin(value.coordinator)); setSignupCredits(value.signupCredits ?? 100); } }).catch(e => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [open]);

  const refresh = useCallback(async (key: Credential, expectedEpoch = epoch.current) => {
    const value = await api("/api/member/me", key) as Snapshot;
    if (epoch.current === expectedEpoch) setSnapshot(value);
    return value;
  }, []);
  useEffect(() => {
    if (!open || !credential) return;
    let pending = false;
    const timer = setInterval(() => {
      if (pending || lock.current || document.visibilityState !== "visible") return;
      const expected = epoch.current;
      pending = true;
      void refresh(credential, expected).catch(e => { if (epoch.current === expected) setError(e.message); }).finally(() => { pending = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [open, credential, refresh]);

  useEffect(() => {
    if (!open || !credential) return;
    let stopped = false;
    void api("/api/member/models", credential).then(value => { if (!stopped) setArtifacts(value.artifacts ?? []); }).catch(e => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [open, credential]);

  useEffect(() => {
    if (!open || !credential || !pairing || pairing.status !== "pending") return;
    let stopped = false, pending = false;
    const expectedEpoch = epoch.current;
    const timer = setInterval(() => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      void api("/api/member/pairings/" + pairing.code, credential).then(async value => {
        if (stopped || epoch.current !== expectedEpoch || value.status !== "paired") return;
        setPairing(current => current?.code === pairing.code ? { ...current, status: "paired" } : current);
        setDeviceForm(false);
        await refresh(credential, expectedEpoch);
        setNotice("PC 등록이 완료되었습니다. PC 도우미에서 ‘검사하고 참여 시작’을 눌러 GPU 제공을 시작하세요.");
      }).catch(error => {
        if (stopped || epoch.current !== expectedEpoch) return;
        setPairing(null);
        setError(error instanceof Error ? error.message : "연결 코드를 다시 만드세요.");
      }).finally(() => { pending = false; });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [open, credential, pairing, refresh]);

  async function run(action: () => Promise<void>, reportError = setError) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (e) { reportError(e instanceof Error ? e.message : "다시 시도하세요."); }
    finally { lock.current = false; setBusy(false); }
  }
  async function register(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (!server) throw Error("서비스 주소를 불러온 뒤 다시 시도하세요.");
      const input = { name: name.trim() };
      const request = requestIdentity(signup, input, true);
      const result = await api("/api/member/register", null, { id: request.id, token: request.token, ...input });
      const key: Credential = { version: 1, kind: "relay-member-account", coordinator: server, id: result.id, token: request.token!, name: result.name };
      epoch.current++; setCredential(key); setSaved(false); setPairing(null); setArtifacts([]); setSelectedArtifact(""); setRentalId(null);
      await refresh(key);
    });
  }
  async function restore(file: File) {
    await run(async () => {
      const value = await jsonFile(file);
      if (value.kind !== "relay-member-account" || value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.token !== "string" || !/^[a-f0-9-]{72}$/.test(value.token)) throw Error("개인 계정 복구 파일을 선택하세요. PC 연결 파일과는 다른 파일입니다.");
      origin(value.coordinator);
      const key = { ...value, coordinator: server } as Credential;
      const result = await api("/api/member/me", key) as Snapshot;
      epoch.current++; setCredential({ ...key, name: result.name }); setSnapshot(result); setSaved(true); setConfig(null); setPairing(null); setDeviceForm(false); setArtifacts([]); setSelectedArtifact(""); setRentalId(null);
    });
  }
  async function registerDevice(event: React.FormEvent) {
    event.preventDefault();
    setDeviceError("");
    await run(async () => {
      if (!credential) throw Error("개인 계정에 먼저 로그인하세요.");
      if (!saved) throw Error("‘계정 복구 파일 저장하고 계속’을 누른 뒤 GPU를 등록하세요.");
      if (contractLoading) throw Error("실행 환경 확인 파일을 읽고 있습니다. 잠시 기다려 주세요.");
      if (!contract) throw Error("PC 도우미에서 저장한 실행 환경 확인 파일을 먼저 가져오세요.");
      if (!pcName.trim()) throw Error("등록할 PC 이름을 입력하세요. 예: 내 데스크톱");
      if (!modelName.trim()) throw Error("모델 이름을 입력하세요. 예: Qwen 모델");
      if (!Number.isFinite(vram) || vram < 1 || vram > 195 || vram * 2 % 1 !== 0) throw Error("GPU 메모리를 1~195 GB 사이에서 0.5 GB 단위로 입력하세요.");
      const input = { name: pcName.trim(), modelName: modelName.trim(), model: contract, vram: Math.round(vram * 1024) };
      const request = requestIdentity(deviceRequest, input, true);
      const value = await api("/api/member/devices", credential, { ...input, requestId: request.id, token: request.token });
      await refresh(credential);
      setConfig({ ...value.config, token: request.token }); setConfigSaved(false);
      setNotice("GPU를 등록했습니다. 관리자 승인 없이 PC에서 제공을 시작할 수 있습니다.");
    }, setDeviceError);
    deviceFeedback.current?.focus();
  }
  async function createPairing() {
    await run(async () => {
      if (!credential || !saved) throw Error("계정 복구 파일을 먼저 저장하세요.");
      const value = await api("/api/member/pairings", credential, {});
      setPairing({ code: value.code, expiresAt: value.expiresAt, status: "pending" });
    });
  }
  async function importModel(file: File) {
    const request = ++modelRead.current, expectedEpoch = epoch.current;
    setContract(null); setContractName(""); setContractLoading(true); setDeviceError(""); setError("");
    try {
      const model = parseModelContract(await jsonFile(file));
      if (modelRead.current !== request || epoch.current !== expectedEpoch) return;
      setContract(model); setContractName(file.name);
      setModelName(current => runtimeOnlyContract(model) ? "GPU 실행 환경" : current === "GPU 실행 환경" ? "" : current);
    } catch (e) {
      if (modelRead.current === request && epoch.current === expectedEpoch) setDeviceError(e instanceof Error ? e.message : "실행 환경 확인 파일을 확인하세요.");
    } finally {
      if (modelRead.current === request) setContractLoading(false);
    }
  }
  async function command(action: string, payload: unknown) {
    if (!credential) return;
    const slot = actionRequests.current[action + JSON.stringify(payload)] ??= emptySlot();
    const request = requestIdentity(slot, { action, payload });
    const response = await api("/api/member/command", credential, { action, payload, requestId: request.id });
    await refresh(credential);
    // A later intentional action with the same input must receive a fresh identity.
    slot.current = null;
    return response.result;
  }
  async function uploadModel(file: File) {
    await run(async () => {
      if (!credential) return;
      if (!saved) throw Error("계정 복구 파일을 저장한 뒤 모델을 업로드하세요.");
      if (!currentNode) throw Error("내 모델을 실행할 수 있는 GPU를 먼저 선택하세요.");
      if (!file.name.toLowerCase().endsWith(".gguf")) throw Error("채팅 템플릿이 포함된 GGUF 모델 파일을 선택하세요.");
      if (!file.size || file.size > 20 * 1024 ** 3) throw Error("20 GB 이하의 GGUF 모델 파일을 선택하세요.");
      setUploadName(file.name); setUploadProgress(0);
      try {
        const artifact = await new Promise<ModelArtifact>((resolve, reject) => {
          const request = new XMLHttpRequest(); uploadRequest.current = request;
          request.open("POST", "/api/member/models");
          request.setRequestHeader("Content-Type", "application/octet-stream");
          request.setRequestHeader("X-Relay-Member", credential.id);
          request.setRequestHeader("Authorization", "Bearer " + credential.token);
          request.setRequestHeader("X-Model-Name", encodeURIComponent(file.name));
          request.upload.onprogress = event => { if (event.lengthComputable) setUploadProgress(Math.round(event.loaded / event.total * 100)); };
          request.onload = () => {
            try {
              const value = JSON.parse(request.responseText);
              if (request.status < 200 || request.status >= 300 || !value.artifact?.id) reject(Error(value.error || "모델 업로드를 완료하지 못했습니다."));
              else resolve(value.artifact);
            } catch { reject(Error("모델 업로드 응답을 확인하지 못했습니다. 다시 시도하세요.")); }
          };
          request.onerror = () => reject(Error("모델 업로드 중 연결이 끊겼습니다. 다시 시도하세요."));
          request.onabort = () => reject(Error("모델 업로드를 취소했습니다."));
          request.send(file);
        });
        setArtifacts(current => [...current.filter(value => value.id !== artifact.id), artifact]);
        setSelectedArtifact(artifact.id); setNotice("내 모델 업로드를 완료했습니다. 프롬프트를 보내면 선택한 GPU에 모델을 올려 실행합니다.");
      } finally { uploadRequest.current = null; setUploadProgress(null); }
    });
  }
  async function startRental(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (!credential) return;
      if (!saved) throw Error("계정 복구 파일을 저장한 뒤 GPU를 빌리세요.");
      const node = currentNode;
      if (!node) throw Error("내 모델을 실행할 수 있는 다른 사람의 GPU를 선택하세요.");
      if (!artifacts.some(artifact => artifact.id === selectedArtifact)) throw Error("GPU에서 사용할 내 GGUF 모델을 업로드하거나 선택하세요.");
      if (!Number.isSafeInteger(contextSize) || contextSize < 4096 || contextSize > (node.context ?? 4096)) throw Error("문맥 크기를 4096 이상, 선택한 GPU의 문맥 한도 이하로 입력하세요.");
      if (!publicData) throw Error("다른 GPU 제공자에게 전달할 수 있는 내용인지 확인하세요.");
      const payload = { title: title.trim() || node.name + " GPU 임대", artifactId: selectedArtifact, allowedNodes: [node.id], context: contextSize, publicData, ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}) };
      const request = requestIdentity(jobRequest, payload);
      const response = await api("/api/member/command", credential, { action: "rent", payload, requestId: request.id });
      const id = response.result?.jobId;
      if (!id) throw Error("GPU 임대 정보를 확인하지 못했습니다. 다시 시도하세요.");
      setRentalId(id);
      await refresh(credential);
      jobRequest.current = null; setTitle(""); setSystemPrompt(""); setPublicData(false);
    });
  }
  async function sendPrompt(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (!rentalJob || rentalJob.status !== "running" || rentalJob.rentalStage !== "ready") throw Error("GPU에서 모델이 준비될 때까지 기다려 주세요.");
      if (!prompt.trim()) throw Error("LLM에게 보낼 메시지를 입력하세요.");
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > Math.min(4096, (rentalJob.model?.context ?? contextSize) - 1)) throw Error("최대 출력 토큰을 문맥 크기보다 작은 1~4096 사이의 정수로 입력하세요.");
      await command("chat", { rentalId: rentalJob.id, prompt: prompt.trim(), maxTokens });
      setPrompt("");
    });
  }
  const book = snapshot?.state.books.live;
  const mine = book?.nodes.filter(node => node.mine) ?? [];
  const offers = book?.nodes.filter(node => !node.mine && !node.revoked) ?? [];
  const ready = offers.filter(node => node.connected && node.status === "online" && !node.busy && node.capabilities?.includes("rental-session"));
  const currentNode = ready.find(node => node.id === selectedNode);
  const currentArtifact = artifacts.find(artifact => artifact.id === selectedArtifact);
  const selectedArtifactInUse = !!currentArtifact && !!book?.jobs.some(job => job.modelArtifact?.id === currentArtifact.id && (job.kind === "rental" && job.status === "running" || job.tasks.some(task => task.status === "ready" || task.status === "leased")));
  const runtimeOnly = runtimeOnlyContract(contract);
  const chatJobs = (book?.jobs ?? []).filter(job => job.kind === "chat" && !job.archived);
  const rentalJobs = (book?.jobs ?? []).filter(job => job.kind === "rental" && !job.archived);
  const rentalJob = rentalId === null ? rentalJobs.find(job => job.status === "running") : rentalJobs.find(job => job.id === rentalId);
  const terminalOpen = rentalId === null ? !!rentalJob : !!rentalId;
  function chooseNode(nodeId: string) {
    const nextContext = Math.min(contextSize, ready.find(node => node.id === nodeId)?.context ?? 4096);
    setSelectedNode(nodeId); setContextSize(nextContext); setMaxTokens(value => Math.min(value, nextContext - 1));
  }
  const earned = book?.ledger.filter(entry => entry.type === "settlement" && entry.to === snapshot?.account).reduce((sum, entry) => sum + (entry.provider ?? 0), 0) ?? 0;
  const spent = book?.ledger.filter(entry => entry.type === "settlement" && entry.from === snapshot?.account).reduce((sum, entry) => sum + entry.amount, 0) ?? 0;
  const status = (node: NodeInfo) => node.revoked ? "연결 해제" : node.status === "paused" ? "제공 일시 중지" : node.connected ? "제공 중" : "PC 연결 대기";
  const downloadAccount = () => { if (credential) { save("relay-account-" + credential.id + ".json", credential); setSaved(true); setDeviceError(""); } };
  const deviceNextStep = !saved ? "계정 복구 파일을 먼저 저장하세요. 저장 전에는 GPU 등록이 진행되지 않습니다."
    : contractLoading ? "실행 환경 확인 파일을 읽고 있습니다. 완료되면 등록을 계속할 수 있습니다."
    : !contract ? "PC 도우미에서 저장한 실행 환경 확인 파일을 가져오세요. 파일 확인 전에는 GPU 등록이 진행되지 않습니다."
    : !pcName.trim() ? "PC 이름을 입력하세요. PC 이름은 필수 항목입니다."
    : !modelName.trim() ? "모델 이름을 입력하세요. 모델 이름은 필수 항목입니다."
    : !Number.isFinite(vram) || vram < 1 || vram > 195 || vram * 2 % 1 !== 0 ? "GPU 메모리를 1~195 GB 사이에서 0.5 GB 단위로 입력하세요."
    : "필수 항목이 준비되었습니다. ‘내 GPU 등록하기’를 누른 다음 연결 설정 파일을 저장하세요.";

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="wide-dialog connection-dialog member-dialog">
      <DialogHeader><DialogTitle>내 GPU·토큰</DialogTitle><DialogDescription>다른 사람의 GPU를 빌려 내 LLM을 올리고 실행하세요. 내 GPU를 제공하면 크레딧을 받습니다.</DialogDescription></DialogHeader>
      <div className="participant-panel">
        {error && <p className="danger member-device-feedback" role="alert" ref={feedback} tabIndex={-1}>{error}</p>}
        {notice && <p className="member-notice" role="status">{notice}</p>}
        {!credential ? <>
          <div className="participant-notice"><b>{tab === "use" ? "다른 GPU를 빌려 내 LLM을 실행하세요" : "하나의 개인 계정으로 제공과 이용을 함께"}</b><p>다른 사람의 GPU를 선택하고 내 GGUF 모델을 업로드하면, 해당 GPU에 모델을 올려 답변을 생성합니다. 내 GPU가 없어도 이용할 수 있습니다.</p></div>
          <form className="form participant-step" onSubmit={register}>
            <h2>내 계정 만들기</h2>
            <label>표시 이름<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy} placeholder="내 이름 또는 별명" /></label>
            <p>계정 복구 파일로 다시 로그인합니다. 가입 시 {signupCredits} CR을 받습니다. GPU 제공 수익이 같은 잔액에 쌓입니다.</p>
            <button className="primary" disabled={busy || !server}>개인 계정 만들기</button>
          </form>
          <div className="participant-resume">
            <input hidden type="file" accept=".json,application/json" ref={importInput} aria-label="계정 복구 파일" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void restore(file); }} />
            <button className="secondary" disabled={busy || !server} onClick={() => importInput.current?.click()}><Upload size={16} /> 계정 복구 파일로 로그인</button>
            <p>관리자 키와 PC 연결 파일은 개인 계정의 로그인 파일이 아닙니다.</p>
          </div>
        </> : <>
          <div className="member-identity"><div><b>{snapshot?.name || credential.name}</b><p className="small">내 계정 · GPU 제공과 이용</p></div><div className="setup-actions"><button className="secondary" onClick={downloadAccount}><Download size={15} /> 계정 복구 파일 저장</button><button className="secondary" disabled={busy} onClick={() => void run(async () => { await refresh(credential); })} aria-label="내 정보 새로고침"><RefreshCw size={15} /></button></div></div>
          {!saved && <div className="participant-notice"><b>계정 복구 파일을 먼저 저장하세요</b><p>새로고침하거나 다른 PC에서 로그인할 때 이 파일이 필요합니다. 잔액과 GPU 소유권은 서버에 보관됩니다.</p></div>}
          {snapshot ? <><div className="member-balances">
            <article><span>사용 가능 크레딧</span><strong data-testid="member-available">{amount(snapshot?.credits.available ?? 0)}</strong><small>현재 잔액 {amount(snapshot?.credits.balance ?? 0)} CR</small></article>
            <article><span>예약 크레딧</span><strong data-testid="member-reserved">{amount(snapshot?.credits.reserved ?? 0)}</strong><small>아직 정산하지 않은 작업</small></article>
            <article><span>GPU 기여 수익</span><strong data-testid="member-earned">{amount(earned)}</strong><small>총 이용 {amount(spent)} CR</small></article>
          </div>
          <Tabs.Root className="grid gap-5" value={tab} onValueChange={value => setTab(value as MemberTab)}>
          <Tabs.List className="member-tabs" aria-label="개인 GPU 메뉴">
            <Tabs.Trigger value="use"><Wallet size={16} /> 다른 GPU 사용</Tabs.Trigger>
            <Tabs.Trigger value="provide"><Cpu size={16} /> 내 GPU 제공</Tabs.Trigger>
            <Tabs.Trigger value="history">이용·수익 내역</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="provide" asChild><section className="participant-step">
            <div className="member-section-head"><h2>내 GPU 제공</h2><button className="secondary" disabled={busy || !saved || (!!config && !configSaved)} onClick={() => { setConfig(null); setDeviceForm(true); deviceRequest.current = null; }}>GPU 추가하기</button></div>
            <p>PC에서 제공을 시작하면 다른 사용자가 업로드한 LLM을 내 GPU에서 실행하고 크레딧을 받습니다. 웹의 일시 중지는 배정을 멈추고 실행 권한을 회수합니다.</p>
            {(deviceForm || !mine.length || config) && <ol className="member-connection-steps" aria-label="GPU 연결 순서">
              <li aria-current={!saved ? "step" : undefined}><b>1. 계정 복구 파일 저장</b><small>{saved ? "저장 요청 완료" : "다음 로그인에 필요"}</small></li>
              <li aria-current={saved && !mine.length ? "step" : undefined}><b>2. 연결 코드 만들기</b><small>{pairing?.status === "pending" ? "PC 도우미에 코드 입력" : mine.length ? "GPU 등록 완료" : "웹에서 일회용 코드 발급"}</small></li>
              <li aria-current={mine.length > 0 && !mine.some(node => node.connected) ? "step" : undefined}><b>3. PC에서 제공 시작</b><small>{mine.some(node => node.connected) ? "GPU 연결됨" : "도우미에서 검사하고 참여 시작"}</small></li>
            </ol>}
            {!mine.length && <div className="member-empty">등록한 GPU가 없습니다. 아래 연결 코드를 PC 도우미에 입력하세요.</div>}
            {mine.map(node => <article className="member-node" key={node.id} data-testid={"member-node-" + node.id}>
              <div><b>{node.name}</b><span className="member-node-status">{status(node)}</span><p>{book?.models.find(model => model.id === node.model)?.name} · {node.vram / 1024} GB</p><small>기여 수익 {amount(node.earned ?? 0)} CR · 완료 {amount(node.completed ?? 0)}건</small></div>
              {!node.revoked && <button className="secondary" disabled={busy} onClick={() => void run(async () => { await command(node.status === "paused" ? "resume" : "pause", { nodeId: node.id }); })}>{node.status === "paused" ? "제공 허용" : "제공 일시 중지"}</button>}
            </article>)}
            <p className="small muted">제공 허용은 배정을 허용하는 설정입니다. 종료된 PC 프로그램을 웹에서 켜지는 않습니다. 실제 GPU 실행과 완전한 종료는 PC 도우미에서 제어합니다.</p>
            {(deviceForm || !mine.length) && !config && <div className="participant-notice member-pairing"><h3>파일 없이 GPU 연결</h3>
              <p>PC 설정 도우미에서 <b>GPU만 제공</b>을 선택하고 llama-server를 확인하세요. 웹에서 만든 코드를 도우미에 입력하면 PC가 검사 결과를 서버로 바로 보냅니다.</p>
              <div className="setup-actions"><a className="secondary" href="/api/participation/provider.zip" download><Download size={16} /> PC 설정 도우미 받기</a><button className="primary" type="button" disabled={busy || !saved} onClick={() => void createPairing()}>{pairing?.status === "pending" ? "새 연결 코드 만들기" : "연결 코드 만들기"}</button></div>
              {pairing?.status === "pending" && <p role="status">연결 코드: <code className="member-pairing-code">{pairing.code}</code><br />{new Date(pairing.expiresAt).toLocaleTimeString("ko-KR")}까지 유효합니다. PC 도우미에서 <b>서버에 바로 연결</b>을 누르세요.</p>}
            </div>}
            {(deviceForm || !mine.length) && !config && <details className="setup-requirements member-legacy-setup"><summary>기존 JSON 파일로 연결하기</summary><form className="form member-device-form" noValidate onSubmit={registerDevice}>
              <h3>GPU 연결하기</h3>
              <p>PC 도우미에서 <b>GPU만 제공</b>을 선택하고 llama-server를 확인한 뒤 <b>파일 검사 → 실행 환경 확인 파일 저장</b>을 누르세요. 내 모델 없이 GPU만 제공할 수 있습니다. 기존 모델 검증 JSON 파일도 사용할 수 있습니다.</p>
              <a className="secondary" href="/api/participation/provider.zip" download><Download size={16} /> PC 설정 도우미 받기</a>
              <input hidden type="file" ref={modelInput} accept=".json,application/json" aria-label="실행 환경 확인 파일" onChange={e => {
                const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!file) return;
                void importModel(file);
              }} />
              <button className="secondary" type="button" disabled={busy} onClick={() => modelInput.current?.click()}><FileCheck2 size={16} /> 실행 환경 확인 파일 가져오기</button>
              {contractLoading && <p className="participant-file" role="status">실행 환경 확인 파일을 읽고 있습니다…</p>}
              {contract && <p className="participant-file" role="status">확인 완료: {contractName} · 문맥 {contract.context}{runtimeOnly ? " · GPU 실행 환경" : ""}</p>}
              {runtimeOnly && <p className="small">실행 환경 확인 파일을 읽었습니다. 이용자가 업로드한 LLM을 실행하므로 제공자가 모델 파일을 준비할 필요가 없습니다.</p>}
              <div className="form-row"><label>PC 이름<input required maxLength={80} value={pcName} onChange={e => setPcName(e.target.value)} disabled={busy} placeholder="내 데스크톱" /></label>{contract && !runtimeOnly && <label>모델 이름<input required maxLength={80} value={modelName} onChange={e => setModelName(e.target.value)} disabled={busy} placeholder="Qwen 모델" /></label>}</div>
              <label>GPU 메모리 (GB)<input type="number" min="1" max="195" step="0.5" required value={vram} onChange={e => setVram(Number(e.target.value))} disabled={busy} /></label>
              {!saved && <div className="member-recovery-step"><b>GPU 등록 전에 계정 복구 파일을 저장하세요</b><p>다음에 로그인할 때 필요합니다. 실행 환경 확인 파일과는 별개이며, 한 번 저장하면 등록을 계속할 수 있습니다.</p><button className="secondary" type="button" onClick={downloadAccount}><Download size={16} /> 계정 복구 파일 저장하고 계속</button></div>}
              <p className="small" id="device-registration-help"><b>현재 할 일: </b>{deviceNextStep}</p>
              {deviceError && <p className="danger member-device-feedback" role="alert" ref={deviceFeedback} tabIndex={-1}>{deviceError}</p>}
              <button className="primary" disabled={busy || contractLoading} aria-describedby="device-registration-help">{busy ? "처리 중…" : contractLoading ? "실행 환경 확인 파일 읽는 중…" : "내 GPU 등록하기"}</button>
            </form></details>}
            {config && <div className="participant-notice"><h3>GPU 연결 설정이 준비되었습니다</h3>
              <p>{configSaved ? "연결 파일을 PC 도우미에서 불러오세요. 다운로드가 진행 중이면 파일 저장이 끝날 때까지 기다리세요." : <><b>아래 ‘연결 설정 저장’을 눌러야 PC 도우미가 연결 파일을 찾을 수 있습니다.</b> GPU 등록만으로 파일이 자동 저장되지는 않습니다.</>}</p>
              <p className="small member-connection-file">연결 파일: relay-provider-{config.node}.json</p>
              <button className="primary" onClick={() => { save("relay-provider-" + config.node + ".json", config); setConfigSaved(true); }}><Download size={16} /> 연결 설정 저장</button>
              <p className="small">다운로드가 끝나면 PC 도우미에서 <b>다음: 연결 설정 → 연결 다시 찾기</b>를 누르세요. 다른 폴더에 저장했거나 다른 연결이 선택되어 있으면 <b>연결 파일 불러오기</b>로 위 파일을 선택하세요.</p>
              <p className="small">연결 파일을 확인하고 <b>검사하고 참여 시작</b>을 누르면 GPU 제공이 시작됩니다.</p>
            </div>}
            {mine.some(node => !node.revoked) && <div className="setup-requirements"><h3>기존 PC 다시 연결</h3><p>같은 PC는 다시 등록할 필요가 없습니다. PC 도우미에서 저장된 연결을 선택하고 ‘검사하고 참여 시작’을 누르세요. 서버 주소가 바뀌었다면 아래에서 기존 파일을 확인한 뒤 다시 저장하세요.</p><input hidden ref={configInput} type="file" accept=".json,application/json" aria-label="내 PC 연결 파일" onChange={e => {
              const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!file) return;
              void run(async () => { const value = await jsonFile(file); const oldCoordinator = origin(value.coordinator);
                const current = await refresh(credential);
                if (!current.state.books.live.nodes.some(node => node.mine && !node.revoked && node.id === value.node)) throw Error("이 계정에 등록된 PC의 연결 파일을 선택하세요.");
                const verified = await api("/api/participation/verify", null, { node: value.node, token: value.token });
                const model = parseModelContract(value.model), approved = parseModelContract(verified.model);
                if (value.pool !== "local-owner" || value.context !== model.context || (["digest", "runtime", "template", "context"] as const).some(field => model[field] !== approved[field])) throw Error("서버의 모델 정보와 연결 파일이 다릅니다.");
                setConfig({ ...value, coordinator: server }); setConfigSaved(oldCoordinator === server); setNotice("기존 PC 연결을 확인했습니다. PC ID는 유지됩니다. 주소가 바뀌었다면 연결 설정을 다시 저장하세요.");
              });
            }} /><button className="secondary" disabled={busy || !server} onClick={() => configInput.current?.click()}>내 PC 연결 파일 불러오기</button></div>}
          </section></Tabs.Content>
          <Tabs.Content value="use" asChild><section className="participant-step">
            {terminalOpen ? <RentalTerminal job={rentalJob} busy={busy} prompt={prompt} setPrompt={setPrompt} maxTokens={maxTokens} setMaxTokens={setMaxTokens} onSend={sendPrompt} onReset={() => void run(async () => { if (!rentalJob) return; await command("reset-chat", { rentalId: rentalJob.id }); setPrompt(""); })} onEnd={() => void run(async () => { if (!rentalJob) return; await command("cancel", { jobId: rentalJob.id }); })} onBack={() => setRentalId("")} /> : <>
            <div className="member-section-head"><div><h2>다른 GPU 빌리기</h2><p>GPU 선택 → 내 모델 업로드 → LLM 터미널</p></div><span className="member-chat-price">입력·출력 1,000토큰당 1 CR</span></div>
            <p className="small">GPU를 빌려 내 GGUF 모델을 올리고 원하는 만큼 대화하세요. 응답에 사용한 토큰에 따라 크레딧이 차감됩니다. 사용을 마치면 터미널에서 GPU 임대를 종료하세요.</p>
            <h3>1. 빌릴 GPU 선택</h3>
            {offers.length > 0 && <div className="member-offers member-chat-offers">{offers.map(node => {
                const available = ready.some(value => value.id === node.id);
                return <article key={node.id} data-selected={selectedNode === node.id}>
                  <div className="member-section-head"><b>{node.name}</b><span data-ready={available}>{status(node)}</span></div>
                  <div className="member-offer-specs"><span>VRAM {node.vram / 1024} GB</span><span>최대 문맥 {amount(node.context ?? 0)} 토큰</span></div>
                  <button className="secondary" disabled={busy || !available} onClick={() => chooseNode(node.id)} aria-pressed={selectedNode === node.id}>{selectedNode === node.id ? "선택됨" : available ? "이 GPU 선택" : !node.connected || node.status !== "online" ? "현재 사용 불가" : node.busy ? "다른 이용자가 사용 중" : "PC 도우미 업데이트 필요"}</button>
                </article>;
              })}</div>}
            {!currentNode && <div className="member-empty" role="status"><b>{ready.length ? "사용할 GPU를 먼저 선택하세요." : "지금 실행 가능한 GPU가 없습니다."}</b><p>{ready.length ? "GPU를 선택하면 모델을 업로드하고 임대를 시작할 수 있습니다." : "제공자가 최신 PC 도우미로 GPU를 연결하면 이용할 수 있습니다. 잠시 후 새로고침하거나 내 GPU를 제공하세요."} 업로드한 모델과 기존 실행 결과는 유지됩니다.</p><div className="setup-actions"><button className="secondary" disabled={busy} onClick={() => void run(async () => { await refresh(credential); })}><RefreshCw size={16} /> GPU 목록 새로고침</button><button className="secondary" onClick={() => setTab("provide")}>내 GPU 제공 방법</button></div></div>}
            {ready.length > 0 && <label className="form">사용할 GPU<select required aria-label="사용할 GPU" value={currentNode?.id ?? ""} onChange={e => chooseNode(e.target.value)} disabled={busy}><option value="">내 모델을 실행할 GPU 선택</option>{ready.map(node => <option key={node.id} value={node.id}>{node.name} · VRAM {node.vram / 1024} GB</option>)}</select></label>}
            {(currentNode || artifacts.length > 0 || uploadProgress !== null || systemPrompt || title) && <form className="form member-chat-form" onSubmit={startRental}>
              <h3>2. 내 LLM 모델 업로드</h3>
              <p className="small">채팅 템플릿이 포함된 GGUF 파일을 지원합니다. 모델 크기와 문맥에 필요한 메모리를 고려해 GPU를 선택하세요.</p>
              <input hidden ref={artifactInput} type="file" aria-label="내 GGUF 모델 파일" accept=".gguf,application/octet-stream" disabled={busy || !saved || !currentNode} onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (file) void uploadModel(file); }} />
              <button className="secondary" type="button" disabled={busy || !saved || !currentNode} onClick={() => artifactInput.current?.click()}><Upload size={16} /> 내 GGUF 모델 업로드</button>
              {uploadProgress !== null && <div className="member-upload-progress" role="status"><b>{uploadName}</b><progress value={uploadProgress} max={100} aria-label="모델 업로드 진행률" /><p>{uploadProgress < 100 ? `${uploadProgress}% 업로드 중` : "업로드 완료 · 서버에서 모델 파일을 확인하고 있습니다."}</p><button type="button" className="text-action" onClick={() => uploadRequest.current?.abort()}>업로드 취소</button></div>}
              {artifacts.length > 0 && <label>실행할 내 모델<select required aria-label="실행할 내 모델" value={selectedArtifact} onChange={e => setSelectedArtifact(e.target.value)} disabled={busy}><option value="">업로드한 모델 선택</option>{artifacts.map(artifact => <option key={artifact.id} value={artifact.id}>{artifact.name} · {(artifact.size / 1024 ** 3).toFixed(2)} GB</option>)}</select></label>}
              {currentArtifact && <><p className="small member-model-file">선택한 모델: {currentArtifact.name} · {(currentArtifact.size / 1024 ** 3).toFixed(2)} GB. 실행 요청 시 선택한 제공자 PC로 전송됩니다.</p>
                <button type="button" className="text-action member-model-delete" disabled={busy || selectedArtifactInUse} aria-describedby={selectedArtifactInUse ? "model-delete-help" : undefined} onClick={() => void run(async () => {
                  if (!credential) return;
                  await api("/api/member/models/" + encodeURIComponent(currentArtifact.id), credential, undefined, "DELETE");
                  setArtifacts(current => current.filter(artifact => artifact.id !== currentArtifact.id)); setSelectedArtifact("");
                  setNotice("선택한 업로드 모델을 삭제했습니다. 기존 실행 내역과 답변은 남아 있습니다.");
                })}>선택 모델 삭제</button>
                {selectedArtifactInUse && <p className="small" id="model-delete-help">실행 중이거나 대기 중인 요청에서 사용하는 모델은 삭제할 수 없습니다.</p>}
              </>}
              <h3>3. GPU 빌리고 대화 시작</h3>
              <details className="member-chat-options"><summary>임대 설정</summary><div className="form">
                <label>임대 이름<input maxLength={100} value={title} onChange={e => setTitle(e.target.value)} disabled={busy || !currentNode} placeholder="비워 두면 GPU 이름으로 표시합니다" /></label>
                <label>시스템 프롬프트<textarea aria-label="시스템 프롬프트" maxLength={16000} rows={3} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} disabled={busy || !currentNode} placeholder="선택 사항 · 대화의 역할, 언어, 형식을 지정하세요." /></label>
                <label>문맥 크기<input type="number" required min={4096} max={currentNode?.context ?? 4096} step={1} value={contextSize} onChange={e => { const value = Number(e.target.value); setContextSize(value); if (value >= 4096) setMaxTokens(current => Math.min(current, value - 1)); }} disabled={busy || !currentNode} /></label>
              </div></details>
              <label className="member-consent"><input type="checkbox" checked={publicData} onChange={e => setPublicData(e.target.checked)} disabled={busy || !currentNode} required />업로드한 모델과 대화 내용은 다른 GPU 제공자에게 전달해도 되는 공개·비민감 자료입니다.</label>
              {!saved && <div className="member-recovery-step"><b>계정 복구 파일을 저장한 뒤 이용하세요</b><p>이용 내역과 잔액을 다음에도 확인할 때 필요합니다.</p><button className="secondary" type="button" onClick={downloadAccount}><Download size={16} /> 계정 복구 파일 저장하고 계속</button></div>}
              <button className="primary" disabled={busy || !saved || !currentNode || !currentArtifact || (snapshot?.credits.available ?? 0) < 1}><Play size={16} />{busy ? "GPU 빌리는 중…" : "GPU 빌리고 LLM 열기"}</button>
              <p className="small">GPU 임대가 시작되면 바로 터미널이 열리고 모델 준비 상태가 표시됩니다. 대화 요청마다 최대 {Math.ceil(contextSize / 1000)} CR을 예약하고 실제 사용한 입력·출력 토큰 1,000개당 1 CR을 정산합니다.</p>
              {(snapshot?.credits.available ?? 0) < 1 && <p className="small">사용 가능한 크레딧이 부족합니다. 내 GPU를 제공해 크레딧을 얻거나 서비스에서 크레딧을 배정받은 뒤 이용하세요.</p>}
            </form>}
            {chatJobs.length > 0 && <div className="member-chat-recent"><h3>이전 요청형 실행</h3>{chatJobs.slice(0, 3).map(job => <ChatResult key={job.id} job={job} modelName={book?.models.find(model => model.id === job.modelId)?.name} busy={busy} onCancel={() => void run(async () => { await command("cancel", { jobId: job.id }); })} />)}{chatJobs.length > 3 && <button className="text-action" onClick={() => setTab("history")}>이전 실행 내역 보기</button>}</div>}
            </>}
          </section></Tabs.Content>
          <Tabs.Content value="history" asChild><section className="participant-step">
            <h2>내 이용·수익 내역</h2>
            {!book?.jobs.some(job => !job.archived) && <p className="member-empty">{book?.jobs.length ? "표시할 작업이 없습니다. 삭제한 원문과 답변은 다시 볼 수 없습니다." : "아직 요청한 작업이 없습니다."}</p>}
            {book?.jobs.filter(job => !job.archived).map(job => <div key={job.id} className="member-history-job">{job.kind === "chat" ? <ChatResult job={job} modelName={book?.models.find(model => model.id === job.modelId)?.name} busy={busy} onCancel={() => void run(async () => { await command("cancel", { jobId: job.id }); })} /> : job.kind === "rental" ? <article className="member-job member-chat-result">
              <div className="member-section-head"><b>{job.title}</b><span>{job.status === "running" ? "GPU 임대 중" : jobStatus[job.status] || job.status}</span></div>
              <p>{job.modelArtifact?.name} · 사용 {amount(job.spent)} CR · 예약 {amount(job.reserved)} CR</p>
              {job.status === "running" && <button className="secondary" onClick={() => { setRentalId(job.id); setTab("use"); }}>LLM 터미널 열기</button>}
              {job.tasks.filter(task => task.messages?.length || task.output).map(task => <div className="member-history-turn" key={task.id}><p><b>나</b> {task.messages?.findLast(message => message.role === "user")?.content}</p>{task.output && <p><b>LLM</b> {task.output}</p>}{task.usage && <small>연산 {amount(task.usage.billable_tokens ?? task.usage.total_tokens ?? 0)} 토큰 · {amount(task.charge ?? 0)} CR</small>}</div>)}
            </article> : <article className="member-job">
              <div className="member-section-head"><b>{job.title}</b><span>{jobStatus[job.status] || job.status}</span></div>
              <p>사용 {job.spent} · 예약 {job.reserved} 토큰</p>
              {["queued", "running"].includes(job.status) && <button className="secondary" disabled={busy} onClick={() => void run(async () => { await command("cancel", { jobId: job.id }); })}>작업 취소</button>}
              {job.tasks.filter(task => task.items?.length).map(task => <dl className="member-results" key={task.id}>{task.items?.map(item => <div key={item.field}><dt>{item.field}</dt><dd>{item.value ?? "찾지 못함"}{item.quote && <small>{item.quote}</small>}</dd></div>)}</dl>)}
            </article>}{["completed", "partial", "cancelled"].includes(job.status) && <div className="setup-actions"><button className="secondary" disabled={busy} onClick={() => save("relay-job-" + job.id + ".json", job)}><Download size={16} /> 결과 JSON 저장</button><AlertDialog><AlertDialogTrigger asChild><button className="text-action" disabled={busy}>원문·답변 삭제</button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>원문과 답변을 영구 삭제할까요?</AlertDialogTitle><AlertDialogDescription>‘{job.title}’의 원문·프롬프트와 결과·답변이 영구 삭제되며 복구할 수 없습니다. 작업은 목록에서 사라지고 이용 금액과 거래 기록은 유지됩니다. 자동 저장은 하지 않습니다. 필요한 내용은 먼저 결과 JSON으로 저장하세요.</AlertDialogDescription></AlertDialogHeader><button className="secondary" onClick={() => save("relay-job-" + job.id + ".json", job)}><Download size={16} /> 결과 JSON 저장</button><AlertDialogFooter><AlertDialogCancel>돌아가기</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void run(async () => { await command("archive", { jobId: job.id }); setNotice("원문과 답변을 영구 삭제했습니다. 이용 금액과 거래 기록은 유지됩니다."); })}>영구 삭제</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>}</div>)}
            <h3>토큰 거래</h3>
            {!book?.ledger.length && <p>아직 토큰 거래가 없습니다.</p>}
            <div className="member-ledger">{[...(book?.ledger ?? [])].reverse().map(entry => {
              const incoming = entry.to === snapshot?.account;
              const value = incoming && entry.type === "settlement" ? entry.provider ?? 0 : entry.amount;
              return <div key={entry.id}><span>{entry.type === "settlement" ? incoming ? "GPU 제공 수익" : "GPU 이용 정산" : incoming ? "토큰 배정" : "토큰 이동"}<small>{new Date(entry.at).toLocaleString("ko-KR")}</small></span><b>{incoming ? "+" : "−"}{amount(value)} CR</b></div>;
            })}</div>
          </section></Tabs.Content>
          </Tabs.Root></> : <p className="member-notice" role="status">{busy ? "계정 정보를 불러오는 중…" : "계정 정보를 불러오지 못했습니다. 내 정보 새로고침을 눌러 다시 시도하세요."}</p>}
          <div className="participant-resume"><p className="small">토큰 잔액(CR)은 GPU 이용에 쓰는 서비스 크레딧입니다. 내 계정과 연결한 모든 PC가 같은 잔액을 사용합니다.</p><button className="text-action" disabled={busy || !saved || (!!config && !configSaved)} onClick={() => { epoch.current++; setCredential(null); setSnapshot(null); setConfig(null); setSaved(false); setError(""); setNotice(""); setArtifacts([]); setSelectedArtifact(""); setSelectedNode(""); setRentalId(null); setPrompt(""); setSystemPrompt(""); setTitle(""); setPublicData(false); signup.current = null; deviceRequest.current = null; jobRequest.current = null; }}>개인 계정 로그아웃</button></div>
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}

export function MemberAllocations() {
  const [members, setMembers] = useState<{ id: string; name: string; account: string; balance: number; available: number }[]>([]);
  const [values, setValues] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<Record<string, ReturnType<typeof emptySlot>>>({});
  const load = useCallback(async () => { const value = await api("/api/member/members"); setMembers(value.members); }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  return <section className="card participant-requests"><div className="card-head"><div><h2>개인 계정 토큰 배정</h2><p className="muted">서비스의 기존 요청자 잔액에서 배정합니다. GPU 등록·사용은 개인이 직접 결정합니다.</p></div><button className="secondary" disabled={busy} onClick={() => void load().catch(e => setError(e.message))}>새로고침</button></div>{error && <p className="danger" role="alert">{error}</p>}{!members.length && <p className="muted">등록된 개인 계정이 없습니다.</p>}{members.map(member => <form className="member-allocation" key={member.id} onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try { const body = { account: member.account, amount: values[member.id] ?? 10 }; const slot = request.current[member.id] ??= emptySlot(); const identity = requestIdentity(slot, body); await api("/api/member/allocate", null, { ...body, requestId: identity.id }); slot.current = null; await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "배정에 실패했습니다."); } finally { setBusy(false); }
  }}><div><b>{member.name}</b><p>잔액 {amount(member.balance)} · 사용 가능 {amount(member.available)} CR</p></div><label>배정 토큰<input type="number" min="1" max="1000" required value={values[member.id] ?? 10} onChange={e => setValues(current => ({ ...current, [member.id]: Number(e.target.value) }))} /></label><button className="secondary" disabled={busy}>토큰 배정</button></form>)}</section>;
}
