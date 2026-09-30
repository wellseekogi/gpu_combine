"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Cpu, RefreshCw, Send, Square } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Group = {
  id: string;
  model: string;
  topology: string;
  status: "unchecked" | "ready" | "unavailable";
  epoch: string;
  contextTokens: number;
  slots: number;
  active: number;
  gpus: { id: string; layers: number; vramMiB: number; kvMiB: number; requiredMiB: number; headroomMiB: number }[];
  requests: number;
  failures: number;
  promptTokens: number;
  outputTokens: number;
  generationMs: number;
};
type Performance = {
  source: "measured" | "estimated";
  firstTokenMs: number;
  tokensPerSecond: number;
  completionRate: number;
  measuredAt: string | null;
  samples: number;
  conditions: { inputTokens: number; outputTokens: number };
};
type Candidate = {
  id: string;
  model: string;
  primaryGroupId: string;
  standbyGroupId: string | null;
  contextTokens: number;
  quantization?: string;
  engineVersion?: string;
  totalHourlyCost: number | null;
  currency: string;
  selectable: boolean;
  performance: { primary: Performance | null; standby: Performance | null };
};
type Workspace = {
  id: string;
  name: string;
  model: string;
  candidateId: string;
  primaryGroupId: string;
  standbyGroupId: string | null;
  activeGroupId: string;
  status: "preparing" | "ready" | "recovering" | "degraded" | "unavailable" | "stopped";
  active: boolean;
  endpoint: string;
  totalHourlyCost: number | null;
  currency: string;
  contextTokens: number;
  recoveries: number;
  lastRecoveryMs: number | null;
  lastError: string | null;
};
type Snapshot = { enabled: boolean; groups: Group[]; candidates?: Candidate[]; workspaces?: Workspace[] };
type Message = { role: "user" | "assistant"; content: string; reasoning_content?: string };
const number = (value: number) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
const statusLabel = { unchecked: "연결 미확인", ready: "준비됨", unavailable: "연결 불가" };
const workspaceStatus = { preparing: "준비 중", ready: "사용 가능", recovering: "복구 중", degraded: "상태 확인 필요", unavailable: "연결 불가", stopped: "종료됨" };
const cost = (value: number | null, currency: string) => value === null ? "비용 미설정" : `${number(value)} ${currency} / 시간`;

export default function InferencePanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [model, setModel] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("direct");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceKeys, setWorkspaceKeys] = useState<Record<string, string>>({});
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const [maxTokens, setMaxTokens] = useState("512");
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [requestError, setRequestError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const statusRequest = useRef<AbortController | null>(null);
  const chatRequest = useRef<AbortController | null>(null);
  const workspaceRequest = useRef<AbortController | null>(null);
  const active = pendingPrompt !== null;
  const groups = snapshot?.groups ?? [];
  const models = [...new Set(groups.map((group) => group.model))];
  const candidates = snapshot?.candidates ?? [];
  const workspaces = snapshot?.workspaces ?? [];
  const candidate = candidates.find((item) => item.id === candidateId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const accessKey = workspaceKeys[workspaceId];
  const requestModel = workspace?.model ?? model;
  const matching = groups.filter((group) => workspace
    ? group.id === workspace.primaryGroupId || group.id === workspace.standbyGroupId
    : group.model === model);
  const contextLimit = workspace?.contextTokens ?? (matching.length ? Math.min(...matching.map((group) => group.contextTokens)) : 0);
  const canSend = !!snapshot?.enabled && matching.length > 0 && (workspaceId === "direct" ||
    (!!workspace && !workspace.active && ["preparing", "ready", "degraded", "unavailable"].includes(workspace.status)));

  const refresh = useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setRefreshing(true);
    const current = () => mounted.current && !controller.signal.aborted && statusRequest.current === controller;
    try {
      const response = await fetch("/api/inference", { signal: controller.signal });
      const result = await response.json();
      if (!current()) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw Error(typeof result.error === "string" ? result.error : "실행 그룹을 불러오지 못했습니다.");
      setSnapshot(result);
      setModel((selected) => selected || result.groups[0]?.model || "");
      setCandidateId((selected) => result.candidates?.some((item: Candidate) => item.id === selected)
        ? selected : result.candidates?.find((item: Candidate) => item.selectable)?.id || result.candidates?.[0]?.id || "");
      setStatusError("");
    } catch (error) {
      if (current()) setStatusError(error instanceof Error ? error.message : "서버 연결을 확인하세요.");
    } finally {
      if (current()) setRefreshing(false);
      if (statusRequest.current === controller) statusRequest.current = null;
    }
  }, [onUnauthorized]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !statusRequest.current) void refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      statusRequest.current?.abort();
      chatRequest.current?.abort();
      workspaceRequest.current?.abort();
    };
  }, [refresh]);

  function stop() {
    chatRequest.current?.abort();
    chatRequest.current = null;
    setPendingPrompt(null);
    setNotice(workspace ? "응답 중지를 요청했습니다. 실행 공간과 자원 예약은 유지됩니다." : "중지를 요청했습니다. 서버가 실행을 정리하면 사용 중 슬롯이 반환됩니다.");
    void refresh();
  }

  function reset(nextModel = model, nextWorkspaceId = workspaceId) {
    chatRequest.current?.abort();
    chatRequest.current = null;
    setPendingPrompt(null);
    setModel(nextModel);
    setWorkspaceId(nextWorkspaceId);
    setHistory([]);
    setPrompt("");
    setSessionId(crypto.randomUUID());
    setRequestError("");
    setNotice("");
    setWorkspaceNotice("");
  }

  async function manageWorkspace(stopping = false) {
    if (workspaceRequest.current || (stopping ? !workspace || workspace.status === "stopped" : !candidate?.selectable || !workspaceName.trim())) return;
    const controller = new AbortController();
    workspaceRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && workspaceRequest.current === controller;
    setWorkspaceBusy(true);
    setWorkspaceError("");
    try {
      const response = await fetch(stopping ? `/api/inference/workspaces/${workspace!.id}` : "/api/inference/workspaces", {
        method: stopping ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(stopping ? {} : { body: JSON.stringify({ candidateId, name: workspaceName.trim() }) }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!current()) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw Error(typeof result.error === "string" ? result.error : "실행 공간을 변경하지 못했습니다.");
      const { accessKey: createdKey, ...updatedWorkspace } = result;
      setSnapshot((previous) => previous && ({ ...previous, workspaces: [...(previous.workspaces ?? []).filter((item) => item.id !== result.id), updatedWorkspace] }));
      if (stopping) {
        chatRequest.current?.abort();
        chatRequest.current = null;
        setPendingPrompt(null);
        setNotice("실행 공간을 종료하고 자원 예약을 해제했습니다.");
      } else {
        if (typeof createdKey === "string") setWorkspaceKeys((previous) => ({ ...previous, [result.id]: createdKey }));
        reset(result.model, result.id);
        setWorkspaceName("");
      }
    } catch (error) {
      if (current()) setWorkspaceError(error instanceof Error ? error.message : "실행 공간을 변경하지 못했습니다.");
    } finally {
      if (current()) {
        setWorkspaceBusy(false);
        void refresh();
      }
      if (workspaceRequest.current === controller) workspaceRequest.current = null;
    }
  }

  async function copyWorkspaceKey() {
    if (!accessKey) return;
    try {
      await navigator.clipboard.writeText(accessKey);
      setWorkspaceNotice("연결 키를 복사했습니다.");
    } catch {
      setWorkspaceError("연결 키를 복사하지 못했습니다. 연결 설정 파일로 저장하세요.");
    }
  }

  function downloadWorkspaceConfig() {
    if (!workspace || !accessKey) return;
    const config = { endpoint: new URL(workspace.endpoint, window.location.origin).href, model: workspace.model, apiKey: accessKey };
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `relay-workspace-${workspace.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setWorkspaceNotice("연결 설정 다운로드를 시작했습니다. 파일에는 연결 키가 포함되어 있습니다.");
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (chatRequest.current || !prompt.trim() || !canSend) return;
    const maxOutput = Number(maxTokens);
    if (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput >= contextLimit || maxOutput > 32768) {
      setRequestError("출력 한도는 1 이상, 모델 문맥 한도 미만의 정수로 입력하세요.");
      return;
    }
    const controller = new AbortController();
    chatRequest.current = controller;
    const submitted = prompt;
    const messages: Message[] = [...history, { role: "user", content: submitted }];
    const current = () => mounted.current && !controller.signal.aborted && chatRequest.current === controller;
    setPendingPrompt(submitted);
    setRequestError("");
    setNotice("");
    try {
      const response = await fetch(workspace ? `/api/inference/workspaces/${workspace.id}/chat` : "/api/inference/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: requestModel, messages, max_tokens: maxOutput, session_id: sessionId, stream: false }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!current()) return;
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) throw Error(typeof result.error === "string" ? result.error : "추론 요청에 실패했습니다.");
      const reply = result.choices?.[0]?.message;
      if (!reply || (typeof reply.content !== "string" && typeof reply.reasoning_content !== "string")) {
        throw Error("모델의 텍스트 응답을 읽을 수 없습니다.");
      }
      setHistory([...messages, { role: "assistant", content: typeof reply.content === "string" ? reply.content : "", reasoning_content: typeof reply.reasoning_content === "string" ? reply.reasoning_content : undefined }]);
      setPrompt("");
      setNotice([
        response.headers.get("X-Relay-Recovered") === "true" ? "예비 그룹으로 전환해 대화 기록으로 답변을 다시 생성했습니다." : "",
        result.choices[0].finish_reason === "length" ? "출력 한도에 도달했습니다. 더 긴 응답이 필요하면 한도를 늘려 이어서 요청하세요." : "",
      ].filter(Boolean).join(" "));
    } catch (error) {
      // Only successful turns enter history, so retry never duplicates the user message.
      if (current()) setRequestError(error instanceof Error ? error.message : "추론 요청에 실패했습니다.");
    } finally {
      if (current()) {
        chatRequest.current = null;
        setPendingPrompt(null);
        void refresh();
      }
    }
  }

  return (
    <div className="setup-guide">
      <section className="card" aria-labelledby="inference-workspace-title">
        <div className="card-head">
          <div><h2 id="inference-workspace-title">전용 실행 공간</h2><p className="muted small">기본 구성은 실행 그룹 하나만 예약합니다. 비용과 성능을 보고 필요하면 예비 그룹을 추가하세요. 같은 주소로 대화와 에이전트를 연결할 수 있습니다.</p></div>
          <button type="button" className="secondary" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? "spin" : ""} /> 상태 새로고침</button>
        </div>
        {statusError && <p className="danger" role="alert" style={{ marginTop: "1rem" }}>{statusError}</p>}
        {!snapshot && !statusError && <p role="status" className="muted" style={{ marginTop: "1rem" }}>실행 공간과 GPU 구성을 확인하고 있습니다.</p>}
        {snapshot?.enabled && candidates.length > 0 && <form className="form" style={{ marginTop: "1.25rem" }} onSubmit={(event) => { event.preventDefault(); void manageWorkspace(); }}>
          <div className="form-row">
            <label htmlFor="inference-candidate">GPU 구성
              <Select value={candidateId} onValueChange={setCandidateId} disabled={workspaceBusy || active}>
                <SelectTrigger id="inference-candidate"><SelectValue placeholder="GPU 구성 선택" /></SelectTrigger>
                <SelectContent>{candidates.map((item) => <SelectItem key={item.id} value={item.id}>{item.model} · {item.primaryGroupId}{item.standbyGroupId ? ` + 예비 ${item.standbyGroupId}` : " · 단일 그룹"} · {cost(item.totalHourlyCost, item.currency)}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label htmlFor="inference-workspace-name">공간 이름
              <input id="inference-workspace-name" value={workspaceName} required maxLength={80} onChange={(event) => setWorkspaceName(event.target.value)} disabled={workspaceBusy || active} placeholder="예: 내 모델 작업 공간" />
            </label>
          </div>
          {candidate && <div>
            <p><b>{cost(candidate.totalHourlyCost, candidate.currency)}</b> · {candidate.standbyGroupId ? "예비 GPU 포함" : "실행 GPU만 예약"} · 문맥 {number(candidate.contextTokens)} 토큰</p>
            <p className="muted small">{candidate.standbyGroupId ? "장애 시 예비 그룹에서 전체 대화 기록으로 답변을 한 번 다시 생성합니다. 예비 그룹 비용이 포함됩니다." : "예비 그룹이 없어 장애 시 자동 전환하지 않습니다. 표시된 비용은 실행 그룹만 포함합니다."}</p>
            <p className="muted small" style={{ margin: ".5rem 0" }}>모델 {candidate.model} · 양자화 {candidate.quantization || "미설정"} · 엔진 {candidate.engineVersion || "미설정"}</p>
            <Table>
              <caption className="sr-only">선택한 GPU 구성의 성능과 측정 조건</caption>
              <TableHeader><TableRow><TableHead>그룹</TableHead><TableHead>성능</TableHead><TableHead>측정 조건</TableHead></TableRow></TableHeader>
              <TableBody>{(["primary", "standby"] as const).map((role) => {
                const performance = candidate.performance[role];
                const groupId = role === "primary" ? candidate.primaryGroupId : candidate.standbyGroupId;
                if (!groupId) return null;
                return <TableRow key={role}>
                  <TableCell>{role === "primary" ? "실행" : "예비"} · {groupId}<br /><span className="muted small">{groups.find((item) => item.id === groupId)?.topology}</span></TableCell>
                  <TableCell>{performance ? <>{performance.source === "measured" ? "실측" : "추정"} · 첫 응답 {number(performance.firstTokenMs / 1000)}초<br />초당 {number(performance.tokensPerSecond)} 토큰 · 완료율 {number(performance.completionRate * 100)}%</> : "미측정"}</TableCell>
                  <TableCell>{performance ? <>입력 {number(performance.conditions.inputTokens)} / 출력 {number(performance.conditions.outputTokens)} 토큰<br />{performance.measuredAt ? <>표본 {number(performance.samples)}개 · {new Date(performance.measuredAt).toLocaleString("ko-KR")}</> : "실측 기록 없음"}</> : "미설정"}</TableCell>
                </TableRow>;
              })}</TableBody>
            </Table>
            <p className="footnote" style={{ marginTop: ".75rem" }}>측정 조건에 따른 참고값이며 모든 요청의 고정 속도를 보장하지 않습니다. 복구 시간은 생성 속도와 별도로 표시합니다.</p>
            {!candidate.selectable && <p className="muted small">이 구성은 현재 선택할 수 없습니다. 비용과 자원 준비 상태를 확인해야 합니다.</p>}
          </div>}
          <button type="submit" className="primary" disabled={workspaceBusy || active || !candidate?.selectable || !workspaceName.trim()}>{workspaceBusy ? "실행 공간 변경 중…" : "실행 공간 만들기"}</button>
        </form>}
        {workspaceBusy && <p role="status" className="muted" style={{ marginTop: "1rem" }}>실행 공간과 자원 예약을 변경하고 있습니다.</p>}
        {snapshot?.enabled && candidates.length === 0 && <p className="muted" style={{ marginTop: "1rem" }}>현재 선택할 수 있는 GPU 구성이 없습니다. 실행 그룹의 비용과 예약 상태를 확인하세요.</p>}
        {snapshot?.enabled && groups.length > 0 && <div className="form" style={{ marginTop: "1.5rem" }}>
          <label htmlFor="inference-workspace">대화할 실행 공간
            <Select value={workspaceId} onValueChange={(value) => reset(workspaces.find((item) => item.id === value)?.model ?? model, value)} disabled={active || workspaceBusy}>
              <SelectTrigger id="inference-workspace"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">직접 실행 · 전용 공간 없음</SelectItem>
                {workspaces.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {workspaceStatus[item.status]}</SelectItem>)}
              </SelectContent>
            </Select>
            <small>공간을 바꾸면 새 대화를 시작합니다.</small>
          </label>
          {workspace && <>
            <p><b>{workspaceStatus[workspace.status]}</b> · {workspace.model} · {cost(workspace.totalHourlyCost, workspace.currency)}{workspace.active ? " · 요청 처리 중" : ""}</p>
            <p className="muted small">선택한 구성 {workspace.primaryGroupId}{workspace.standbyGroupId ? ` + 예비 ${workspace.standbyGroupId}` : " · 단일 그룹"} · 현재 실행 {workspace.activeGroupId}</p>
            {!workspace.standbyGroupId && <p className="muted small">예비 그룹이 없어 장애 시 자동 전환하지 않습니다.</p>}
            <label htmlFor="inference-workspace-endpoint">고정 API 주소
              <input id="inference-workspace-endpoint" readOnly value={new URL(workspace.endpoint, window.location.origin).href} onFocus={(event) => event.target.select()} />
              <small>이 실행 공간의 연결 주소입니다. 공간마다 한 번에 요청 하나를 처리합니다.</small>
            </label>
            {workspace.status !== "stopped" && (accessKey ? <>
              <label htmlFor="inference-workspace-key">연결 키
                <input id="inference-workspace-key" type="password" readOnly autoComplete="off" value={accessKey} onFocus={(event) => event.target.select()} />
                <small>이 브라우저 화면을 새로고침하거나 로그아웃하면 다시 표시할 수 없습니다. 연결 키를 복사하거나 연결 설정을 저장하세요.</small>
              </label>
              <div className="setup-actions">
                <button type="button" className="secondary" onClick={() => void copyWorkspaceKey()}>연결 키 복사</button>
                <button type="button" className="secondary" onClick={downloadWorkspaceConfig}>연결 설정 저장</button>
              </div>
            </> : <p className="muted small">연결 키는 다시 표시할 수 없습니다. 저장한 연결 설정을 사용하거나, 키를 보관하지 않았다면 새 실행 공간을 만드세요.</p>)}
            {workspaceNotice && <p className="muted small" role="status">{workspaceNotice}</p>}
            {workspace.standbyGroupId && <p className="muted small">복구 {number(workspace.recoveries)}회 · 최근 복구 {workspace.lastRecoveryMs === null ? "미측정" : `${number(workspace.lastRecoveryMs / 1000)}초`}</p>}
            {workspace.status === "recovering" && <p role="status" className="muted">예비 그룹으로 전환 중입니다. 대화 기록으로 문맥을 다시 계산하고 미완료 답변을 새로 생성합니다.</p>}
            {workspace.status === "degraded" && <p role="status" className="muted">{workspace.standbyGroupId ? "다음 요청에서 실행 상태를 다시 확인합니다. 추가 장애에 대비한 예비 상태도 확인해야 합니다." : "다음 요청에서 실행 그룹의 연결과 준비 상태를 다시 확인합니다."}</p>}
            {workspace.lastError && <p className="danger" role="alert">{workspace.lastError}</p>}
            <div><button type="button" className="secondary" disabled={workspaceBusy || workspace.status === "stopped"} onClick={() => void manageWorkspace(true)}><Square size={15} /> {workspaceBusy ? "실행 공간 변경 중…" : "실행 공간 종료"}</button><p className="muted small" style={{ marginTop: ".5rem" }}>종료하면 진행 중인 응답을 중지하고 이 공간의 자원 예약을 해제합니다.</p></div>
          </>}
        </div>}
        {workspaceError && <p className="danger" role="alert" style={{ marginTop: "1rem" }}>{workspaceError}</p>}
      </section>

      <section className="card" aria-labelledby="inference-groups-title">
        <div className="card-head">
          <div><h2 id="inference-groups-title">분산 실행 그룹</h2><p className="muted small">구성된 GPU에 모델 레이어와 KV 캐시를 배치해 하나의 모델을 실행합니다.</p></div>
        </div>
        {snapshot && (!snapshot.enabled || groups.length === 0) && (
          <div className="empty">
            <Cpu size={30} /><h3>분산 실행 그룹이 아직 없습니다.</h3>
            <p>먼저 운영자가 GPU와 모델의 분산 실행 설정을 준비해야 합니다. 준비가 끝나면 상태를 새로고침하세요.</p>
            <details className="setup-requirements" style={{ textAlign: "left", maxWidth: "42rem", overflowWrap: "anywhere" }}>
              <summary>분산 LLM 준비 방법</summary>
              <ol style={{ paddingLeft: "1.25rem", lineHeight: 1.8 }}>
                <li>서버 폴더의 <code>docs/distributed-inference-ko.md</code>를 열고, <code>docs/examples/inference.config.json</code>을 복사해 실제 GPU·모델·비용으로 설정합니다.</li>
                <li>안내에 따라 신뢰할 수 있는 사설망에서 GPU 실행기를 시작합니다. 실행 그룹 하나로 전용 공간을 만들 수 있으며, 자동 전환이 필요하면 같은 모델의 예비 그룹을 추가합니다.</li>
                <li>설정 파일을 <code>RELAY_INFERENCE_CONFIG</code>로 지정해 Relay 서버를 다시 시작한 뒤, 이 화면에서 GPU 구성을 선택합니다.</li>
              </ol>
            </details>
            <button type="button" className="secondary" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? "spin" : ""} /> 준비 후 다시 확인</button>
          </div>
        )}
        {groups.map((group) => (
          <details key={group.id} open style={{ marginTop: "1.25rem" }}>
            <summary style={{ cursor: "pointer", overflowWrap: "anywhere" }}><b>{group.model}</b> · {group.id} · {statusLabel[group.status]} · 사용 중 {group.active} / {group.slots} 슬롯</summary>
            <p className="muted small" style={{ margin: ".75rem 0" }}>{group.topology} · 문맥 {number(group.contextTokens)} 토큰 / 슬롯 · 실행 세대 {group.epoch}</p>
            <Table>
              <caption className="sr-only">{group.id} 그룹의 GPU별 설정 메모리 예산, 단위 MiB</caption>
              <TableHeader><TableRow><TableHead>GPU</TableHead><TableHead>레이어</TableHead><TableHead className="text-right">VRAM</TableHead><TableHead className="text-right">KV 예약</TableHead><TableHead className="text-right">필요량</TableHead><TableHead className="text-right">여유</TableHead></TableRow></TableHeader>
              <TableBody>{group.gpus.map((gpu) => <TableRow key={gpu.id}><TableCell>{gpu.id}</TableCell><TableCell>{gpu.layers}</TableCell><TableCell className="text-right mono">{number(gpu.vramMiB)}</TableCell><TableCell className="text-right mono">{number(gpu.kvMiB)}</TableCell><TableCell className="text-right mono">{number(gpu.requiredMiB)}</TableCell><TableCell className="text-right mono">{number(gpu.headroomMiB)}</TableCell></TableRow>)}</TableBody>
            </Table>
            <p className="muted small" style={{ marginTop: ".75rem" }}>누적 요청 {number(group.requests)} · 실패 {number(group.failures)} · 처리 입력 {number(group.promptTokens)} / 확인된 출력 {number(group.outputTokens)} 토큰 · 요청 처리 시간 {number(group.generationMs / 1000)}초</p>
          </details>
        ))}
        {groups.length > 0 && <p className="footnote" style={{ marginTop: "1rem" }}>메모리는 설정에 따른 예산(MiB)이며 실시간 GPU 측정값은 아닙니다. 사용량은 5초마다 갱신합니다.</p>}
      </section>

      {snapshot?.enabled && groups.length > 0 && (
        <section className="card" aria-labelledby="inference-chat-title">
          <div className="card-head"><h2 id="inference-chat-title">모델과 대화</h2><button type="button" className="secondary" onClick={() => reset()}>새 대화</button></div>
          <p className="muted small" style={{ margin: ".75rem 0 1.25rem" }}>각 요청에 이 화면의 전체 대화를 보냅니다. 문맥 한도를 넘으면 실행 전에 안내하며, 새로고침하거나 로그아웃하면 대화 기록이 사라집니다.</p>
          <form className="form" onSubmit={(event) => void send(event)}>
            <div className="form-row">
              <label htmlFor="inference-model">모델
                <Select value={requestModel} onValueChange={(value) => reset(value)} disabled={active || !!workspace || workspaceBusy}>
                  <SelectTrigger id="inference-model"><SelectValue placeholder="모델 선택" /></SelectTrigger>
                  <SelectContent>{models.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                </Select>
                <small>{workspace ? "선택한 실행 공간의 모델을 사용합니다." : "모델을 바꾸면 새 대화를 시작합니다."}</small>
              </label>
              <label htmlFor="inference-output">최대 출력 토큰
                <input id="inference-output" type="number" min={1} max={Math.max(1, Math.min(32768, contextLimit - 1))} step={1} required value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} disabled={active} />
                <small>입력과 출력 합계 {number(contextLimit)} 토큰까지 사용할 수 있습니다.</small>
              </label>
            </div>
            {history.length > 0 && <div role="log" aria-label="대화 기록" aria-live="polite" style={{ display: "grid", gap: "1rem" }}>{history.map((message, index) => (
              <article key={index} style={{ borderTop: "1px solid var(--border)", paddingTop: "1rem", minWidth: 0 }}>
                <b className="small">{message.role === "user" ? "나" : requestModel}</b>
                {message.reasoning_content && <details className="setup-requirements"><summary>모델 추론 출력</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.reasoning_content}</p></details>}
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: ".5rem" }}>{message.content || "텍스트 답변 없이 추론 출력만 반환되었습니다."}</p>
              </article>
            ))}</div>}
            {active && <p role="status" className="muted"><RefreshCw size={15} className="spin inline" /> {workspace?.status === "recovering" ? "연결을 복구하고 답변을 다시 생성하고 있습니다." : "응답을 생성하고 있습니다. 완료되면 답변을 표시합니다."}</p>}
            <label htmlFor="inference-prompt">메시지
              <textarea id="inference-prompt" rows={5} required value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={active} placeholder="모델에 요청할 내용을 입력하세요." />
            </label>
            {requestError && <div className="error-banner" role="alert"><AlertCircle size={18} /><span>{requestError}</span></div>}
            {notice && <p className="muted small" role="status">{notice}</p>}
            <div className="setup-actions">
              <button type="submit" className="primary" disabled={active || workspaceBusy || !prompt.trim() || !canSend}><Send size={16} /> 보내기</button>
              {active && <button type="button" className="secondary" onClick={stop}><Square size={15} /> 중지</button>}
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
