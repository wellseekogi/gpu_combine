"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Layers3,
  Cpu,
  Plus,
  ShieldCheck,
  LayoutDashboard,
  ListTodo,
  Wallet,
  ArrowUpRight,
  ArrowRight,
  FileText,
  Download,
  Pause,
  Play,
  RefreshCw,
  Check,
  Clock,
  AlertCircle,
  BookOpen,
  Upload,
  X,
  Activity,
  Trash2,
  Server,
  Monitor,
  LogOut,
} from "lucide-react";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Toaster, toast } from "sonner";
import SetupGuide from "./setup-guide";
import InferencePanel from "./inference-panel";
import ServiceHome from "./service-home";
import ParticipantPanel, { MemberAllocations } from "./participant-panel";
import { connectionConfig, parseModelContract } from "@/lib/relay/setup.mjs";
type Any = any;
type Submission = { fingerprint: string; requestId: string };
function submissionId(ref: { current: Submission | null }, mode: string, action: string, payload: Any) {
  const fingerprint = JSON.stringify({ mode, action, payload });
  if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, requestId: crypto.randomUUID() };
  return ref.current.requestId;
}
const labels: Record<string, string> = {
  queued: "대기 중",
  running: "실행 중",
  completed: "완료",
  partial: "부분 완료",
  cancelled: "취소",
  ready: "배정 대기",
  leased: "실행 중",
  settled: "확정",
  failed: "실패",
  passed: "근거 확인",
  pending: "검증 대기",
};
const nav = [
  ["LLM 실행", Play],
  ["시작하기", Play],
  ["워크스페이스", LayoutDashboard],
  ["작업", ListTodo],
  ["분산 LLM", Server],
  ["GPU 노드", Cpu],
  ["크레딧 원장", Wallet],
  ["설계와 운영", BookOpen],
] as const;
const emptyDoc = () => ({ title: "", url: "", text: "" });
const samples = ["Atlas Runtime", "Boreal Engine", "Cedar Inference"].map(
  (title, i) => ({
    title: title + " · 예제 문서",
    url: "",
    text:
      "체험을 위해 만든 가상 기술 명세입니다.\n라이선스: " +
      (i === 1 ? "Apache-2.0" : "MIT") +
      "\n지원 GPU: NVIDIA CUDA\n메모리: 최소 " +
      [8, 16, 6][i] +
      "GB VRAM\n노드 소유자는 언제든 제공을 중단할 수 있습니다.",
  }),
);
const fmt = (n: number) => new Intl.NumberFormat("ko-KR").format(n ?? 0);
const date = (n: number) =>
  new Date(n).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const progress = (j: Any) =>
  Math.round(
    (j.documents.filter(
      (d: Any) =>
        j.tasks.find((t: Any) => t.id === d.taskId)?.status === "settled",
    ).length /
      j.documents.length) *
      100,
  );
function Badge({ value }: { value: string }) {
  return (
    <span className={"status status-" + value}>{labels[value] ?? value}</span>
  );
}
function save(name: string, text: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJob(j: Any, format: string) {
  const rows = j.documents.flatMap((d: Any) => {
    const t = j.tasks.find((t: Any) => t.id === d.taskId);
    return (
      t.items?.length ? t.items : [{ field: "", value: null, quote: null }]
    ).map((v: Any) => ({
      document: d.title,
      source: d.url,
      document_hash: d.hash,
      field: v.field,
      value: v.value,
      quote: v.quote,
      start_utf16: v.start,
      end_utf16: v.end,
      quality: t.quality,
      status: t.status,
      backend: j.mode === "demo" ? "fixture (not LLM)" : "llama.cpp",
      task_id: t.id,
      receipt: t.receipt ?? null,
    }));
  });
  if (format === "jsonl")
    save(
      j.title + ".jsonl",
      rows.map((r: Any) => JSON.stringify(r)).join("\n"),
    );
  if (format === "csv") {
    const keys = Object.keys(rows[0]);
    const safe = (x: Any) => {
      let s = String(x ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    save(
      j.title + ".csv",
      "\uFEFF" +
        [keys, ...rows.map((r: Any) => keys.map((k) => r[k]))]
          .map((a) => a.map(safe).join(","))
          .join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }
  if (format === "md") {
    const esc = (x: Any) =>
      String(x ?? "—")
        .replace(/[\\*_[\]<>|#]/g, "\\$&")
        .replace(/\n/g, " ");
    save(
      j.title + ".md",
      "# " +
        esc(j.title) +
        "\n\n실행: " +
        (j.mode === "demo" ? "규칙 기반 체험" : "llama.cpp") +
        " · " +
        labels[j.status] +
        " · " +
        j.spent +
        " CR\n\n" +
        rows
          .map(
            (r: Any) =>
              "## " +
              esc(r.document) +
              " / " +
              esc(r.field) +
              "\n\n" +
              esc(r.value) +
              "\n\n> " +
              esc(r.quote) +
              "\n\n출처: " +
              esc(r.source || "제출 원문") +
              " · SHA-256: " +
              r.document_hash +
              "\n",
          )
          .join("\n"),
    );
  }
}
function WorkspaceNavigation({
  section,
  onChange,
  onProvide,
  operator,
}: {
  section: string;
  onChange: (label: string) => void;
  onProvide: () => void;
  operator: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="주요 메뉴">
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton isActive={section === "LLM 실행"} aria-current={section === "LLM 실행" ? "page" : undefined} size="lg" onClick={() => { onChange("LLM 실행"); setOpenMobile(false); }}><Play /><span>LLM 실행</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton size="lg" onClick={() => { onProvide(); setOpenMobile(false); }}><Cpu /><span>GPU 제공</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
      <details className="operator-navigation" open={operator}>
        <summary>운영자 도구</summary>
        <SidebarMenu>
        {nav.filter(([label]) => label !== "LLM 실행").map(([label, Icon]) => (
          <SidebarMenuItem key={label}>
            <SidebarMenuButton
              isActive={section === label}
              aria-current={section === label ? "page" : undefined}
              size="lg"
              onClick={() => {
                onChange(label);
                setOpenMobile(false);
              }}
            >
              <Icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
        </SidebarMenu>
      </details>
    </nav>
  );
}
export default function Home() {
  const [data, setData] = useState<Any>(null),
    [mode, setMode] = useState("live"),
    [section, setSection] = useState("LLM 실행"),
    [error, setError] = useState(""),
    [auth, setAuth] = useState(false),
    [busy, setBusy] = useState(false),
    [newOpen, setNewOpen] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [confirm, setConfirm] = useState<Any>(null),
    [modal, setModal] = useState<string | null>(null),
    [credential, setCredential] = useState<Any>(null),
    [search, setSearch] = useState("");
  const [payer, setPayer] = useState("requester"),
    [title, setTitle] = useState(""),
    [fields, setFields] = useState("라이선스, 지원 GPU, 메모리"),
    [documents, setDocuments] = useState<Any[]>([emptyDoc()]),
    [budget, setBudget] = useState(60),
    [minutes, setMinutes] = useState(30),
    [publicData, setPublicData] = useState(false),
    [modelId, setModelId] = useState(""),
    [allowed, setAllowed] = useState<string[]>([]),
    [adminToken, setAdminToken] = useState("");
  const [contractFile, setContractFile] = useState(""),
    [manualModel, setManualModel] = useState(false),
    [setupDownloading, setSetupDownloading] = useState(false),
    [creatingNode, setCreatingNode] = useState(false),
    [credentialSaved, setCredentialSaved] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [connection, setConnection] = useState<"checking" | "connected" | "disconnected">("checking");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [memberTab, setMemberTab] = useState<"provide" | "use" | "history">("provide");
  const pairing = useRef(false), contractInput = useRef<HTMLInputElement>(null), connectionFlow = useRef(false);
  // Keep uncertain submissions in memory until acknowledged, edited, or explicitly reset.
  const creatingJob = useRef(false);
  const jobSubmission = useRef<Submission | null>(null);
  const modelSubmission = useRef<Submission | null>(null);
  const nodeSubmission = useRef<Submission | null>(null);
  const nodeCredential = useRef<{ fingerprint: string; token: string } | null>(null);
  const [modelForm, setModelForm] = useState({
      name: "",
      digest: "",
      runtime: "",
      template: "",
      context: 8192,
      minVram: 4096,
    }),
    [nodeForm, setNodeForm] = useState({ name: "", modelId: "", vram: 8192 });
  const pending = useRef(false),
    modeRef = useRef(mode),
    fileInput = useRef<HTMLInputElement>(null),
    viewEpoch = useRef(0),
    sessionEpoch = useRef(0),
    readSequence = useRef(0),
    activeRead = useRef<AbortController | null>(null),
    mutations = useRef(0),
    mutationSession = useRef(0),
    visibleMutations = useRef(0),
    refreshAfterMutation = useRef(false),
    signingOut = useRef(false);
  modeRef.current = mode;
  const invalidateReads = useCallback(() => {
    viewEpoch.current++;
    activeRead.current?.abort();
    activeRead.current = null;
  }, []);
  const clearAuthentication = useCallback(() => {
    sessionEpoch.current++;
    invalidateReads();
    refreshAfterMutation.current = false;
    setData(null);
    setLastUpdated(null);
    setAuth(true);
    setError("");
    setSelected(null);
    setCredential(null);
    jobSubmission.current = modelSubmission.current = nodeSubmission.current = null;
    nodeCredential.current = null;
    setModal((current) => current === "connection" || connectionFlow.current ? "connection" : null);
    setNewOpen(false);
    setConfirm(null);
    setAdminToken("");
    setBusy(false);
  }, [invalidateReads]);
  const load = useCallback(async (reconnecting = false) => {
    if ((mutationSession.current === sessionEpoch.current && mutations.current > 0) || signingOut.current) return;
    if (reconnecting) setConnection("checking");
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    const epoch = viewEpoch.current;
    const session = sessionEpoch.current;
    const sequence = ++readSequence.current;
    const current = () =>
      !controller.signal.aborted &&
      epoch === viewEpoch.current &&
      session === sessionEpoch.current &&
      sequence === readSequence.current &&
      (mutationSession.current !== sessionEpoch.current || mutations.current === 0) &&
      !signingOut.current;
    try {
      const r = await fetch("/api/relay", { signal: controller.signal });
      const d: Any = await r.json();
      if (!current()) return;
      if (!r.ok) {
        if (r.status === 401) {
          setConnection("connected");
          clearAuthentication();
          return;
        }
        throw Error(d.error ?? "연결 실패");
      }
      setData(d);
      setConnection("connected");
      setLastUpdated(Date.now());
      setError("");
      setAuth(false);
    } catch (e: Any) {
      if (current()) {
        setConnection("disconnected");
        setError(e instanceof TypeError ? "서버에 연결할 수 없습니다. 서버 실행 상태와 네트워크를 확인하세요." : e.message);
      }
    } finally {
      if (activeRead.current === controller) activeRead.current = null;
    }
  }, [clearAuthentication]);
  const act = useCallback(
    async (action: string, payload: Any = {}, quiet = false, requestId: string = crypto.randomUUID()) => {
      if (signingOut.current) throw new DOMException("로그아웃 중입니다.", "AbortError");
      invalidateReads();
      const epoch = viewEpoch.current;
      const session = sessionEpoch.current;
      if (mutationSession.current !== session) {
        mutationSession.current = session;
        mutations.current = 0;
        visibleMutations.current = 0;
        refreshAfterMutation.current = false;
      }
      mutations.current++;
      if (!quiet) {
        visibleMutations.current++;
        setBusy(true);
      }
      try {
        const r = await fetch("/api/relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: modeRef.current,
            action,
            payload,
            requestId,
          }),
        });
        const d: Any = await r.json();
        if (session !== sessionEpoch.current || signingOut.current)
          throw new DOMException("세션이 변경되었습니다.", "AbortError");
        if (r.status === 401) {
          clearAuthentication();
          throw new DOMException("다시 로그인하세요.", "AbortError");
        }
        if (!r.ok) throw Error(d.error ?? "요청 실패");
        refreshAfterMutation.current = true;
        if (epoch === viewEpoch.current) {
          setData(d);
          setConnection("connected");
          setLastUpdated(Date.now());
          setError("");
        }
        return d.result;
      } catch (e: Any) {
        if (e.name !== "AbortError" && session === sessionEpoch.current) {
          const message = e instanceof TypeError ? "서버에 연결할 수 없습니다. 연결 후 다시 시도하세요." : e.message;
          if (e instanceof TypeError) setConnection("disconnected");
          setError(message);
          if (!quiet) toast.error(message);
        }
        throw e;
      } finally {
        if (mutationSession.current === session) {
          mutations.current--;
          if (!quiet) {
            visibleMutations.current--;
            if (session === sessionEpoch.current) setBusy(visibleMutations.current > 0);
          }
        }
        if (mutationSession.current === session && mutations.current === 0 && session === sessionEpoch.current && !signingOut.current) {
          invalidateReads();
          if (refreshAfterMutation.current) {
            refreshAfterMutation.current = false;
            void load();
          }
        }
      }
    },
    [clearAuthentication, invalidateReads, load],
  );
  const run = async (a: string, p: Any = {}, message?: string) => {
    try {
      await act(a, p);
      if (message) toast.success(message);
      return true;
    } catch {
      /* Errors are already shown by the action handler. */
      return false;
    }
  };
  const openConnectionSetup = useCallback(() => {
    connectionFlow.current = true;
    setMemberTab("provide");
    setMode("live");
    setSection("LLM 실행");
    setSelected(null);
    setSearch("");
    setModal("connection");
    // Keep the destination shareable without a second hash event reopening it.
    if (window.location.hash !== "#connect-pc") {
      window.history.pushState(null, "", window.location.pathname + window.location.search + "#connect-pc");
    }
  }, []);
  const openLlm = useCallback(() => {
    connectionFlow.current = true;
    setMemberTab("use");
    setMode("live");
    setSection("LLM 실행");
    setSelected(null);
    setModal("connection");
    if (window.location.hash !== "#run-llm") window.history.pushState(null, "", window.location.pathname + window.location.search + "#run-llm");
  }, []);
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === "#connect-pc") openConnectionSetup();
      else if (window.location.hash === "#run-llm") openLlm();
      else {
        connectionFlow.current = false;
        setModal(current => current === "connection" ? null : current);
      }
    };
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [openConnectionSetup, openLlm]);
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("setup-token");
    if (token) {
      // Remove the one-use launch credential from browser history before any API call.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      void (async () => {
        try {
          const response = await fetch("/api/launch-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (!response.ok) throw Error("자동 연결 시간이 지났거나 이미 사용한 링크입니다. 관리자 키로 로그인하거나, 기존 Relay 실행 창을 닫은 뒤 START-RELAY.cmd를 다시 여세요.");
          await load();
        } catch (e: Any) {
          setAuth(true);
          setError(e.message);
        }
      })();
    } else void load();
    return () => invalidateReads();
  }, [invalidateReads, load]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        !data ||
        auth ||
        pending.current ||
        document.visibilityState !== "visible"
      )
        return;
      pending.current = true;
      load()
        .catch(() => {})
        .finally(() => {
          pending.current = false;
        });
    }, 2200);
    return () => clearInterval(timer);
  }, [data, auth, load]);
  const b = data?.state.books[mode],
    jobs = (b?.jobs ?? []).filter((j: Any) => !j.archived && j.kind !== "chat"),
    nodes = b?.nodes ?? [],
    models = b?.models ?? [],
    job = b?.jobs.find((j: Any) => j.id === selected);
  const openNew = (sample = false) => {
    if (creatingJob.current) return;
    if (!sample && mode === "live" && !models.length) {
      setSection("시작하기");
      toast.info("작업을 만들기 전에 사용할 모델을 준비하세요.");
      return;
    }
    jobSubmission.current = null;
    setTitle(sample ? "공개 기술 문서 비교" : "");
    setDocuments(sample ? samples.map((d) => ({ ...d })) : [emptyDoc()]);
    setFields("라이선스, 지원 GPU, 메모리");
    setModelId(models[0]?.id ?? "");
    setPublicData(sample);
    setPayer("requester");
    setAllowed([]);
    setNewOpen(true);
  };
  function openDemo() {
    setMode("demo");
    openNew(true);
    setModelId("fixture-v1");
  }
  async function downloadSetup() {
    if (setupDownloading) return;
    setSetupDownloading(true);
    try {
      const response = await fetch("/api/setup/provider.zip");
      if (!response.ok) throw Error("설정 도우미를 받지 못했습니다. 서버 연결과 로그인을 확인하고 다시 시도하세요.");
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "relay-pc-setup.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("ZIP을 풀고 START-PROVIDER.cmd를 열어주세요.");
    } catch (e: Any) { toast.error(e.message); }
    finally { setSetupDownloading(false); }
  }
  async function importContract(file?: File) {
    if (!file) return;
    try {
      if (file.size > 16000) throw Error("모델 확인 JSON 파일은 16KB 이하여야 합니다.");
      const contract = parseModelContract(JSON.parse(await file.text()));
      setModelForm((form) => ({ ...form, ...contract }));
      setContractFile(file.name);
      setManualModel(false);
      toast.success("모델 확인 정보를 가져왔습니다. 이름과 메모리를 확인하고 승인하세요.");
    } catch (e: Any) {
      toast.error(e instanceof SyntaxError ? "JSON 파일을 읽을 수 없습니다. PC 설정 도우미에서 다시 저장하세요." : e.message);
    }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (creatingJob.current) return;
    if (allowed.some(id => !nodes.some((node: Any) => node.id === id && !node.revoked && node.model === (modelId || models[0]?.id)))) {
      toast.error("선택한 모델을 지원하는 제공자를 다시 선택하세요.");
      return;
    }
    creatingJob.current = true;
    try {
      const payload = {
        title,
        payer,
        fields: fields
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        documents,
        budget,
        minutes,
        publicData,
        modelId: modelId || models[0]?.id,
        allowedNodes: allowed,
      };
      const requestId = submissionId(jobSubmission, modeRef.current, "create", payload);
      const r = await act("create", payload, false, requestId);
      jobSubmission.current = null;
      setNewOpen(false);
      setSelected(r.jobId);
      toast.success("작업을 제출하고 비용을 예약했습니다.");
      await load();
    } catch {
      /* Errors are already shown by the action handler. The request ID survives retry. */
    } finally {
      creatingJob.current = false;
    }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    try {
      const docs: Any[] = [];
      for (const f of Array.from(files)) {
        if (f.size > 24000)
          throw Error("파일당 24KB 이하의 텍스트를 선택하세요.");
        const text = await f.text();
        if (f.name.endsWith(".jsonl"))
          docs.push(
            ...text
              .split(/\r?\n/)
              .filter(Boolean)
              .map((x) => JSON.parse(x)),
          );
        else if (/\.(txt|md)$/i.test(f.name))
          docs.push({ title: f.name, url: "", text });
        else throw Error(".txt, .md, .jsonl 파일을 지원합니다.");
      }
      if (
        !docs.length ||
        docs.length > 4 ||
        docs.some((d) => !d || typeof d !== "object" || Array.isArray(d) || typeof d.text !== "string" || d.text.length > 4000)
      )
        throw Error("최대 4개 문서, 문서당 4,000자입니다.");
      setDocuments(
        docs.map((d) => ({
          title: d.title ?? "가져온 문서",
          url: d.url ?? "",
          text: d.text,
        })),
      );
    } catch (e: Any) {
      toast.error(e.message);
    }
  }
  function jobTable(list: Any[], filtering = false) {
    return list.length ? (
      <>
        <div className="job-mobile-list">
          {list.map((j) => (
            <button
              className="job-mobile-row"
              key={j.id}
              onClick={() => setSelected(j.id)}
            >
              <span className="mobile-job-title">
                <FileText size={18} />
                <b>{j.title}</b>
                <ArrowRight size={15} />
              </span>
              <span className="mobile-job-meta">
                <Badge value={j.status} />
                <span>
                  {j.documents.length}개 문서 · {progress(j)}%
                </span>
                <span className="mono">
                  {j.spent} / {j.budget} CR
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="table-wrap job-desktop-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>작업 이름</TableHead>
                <TableHead>진행</TableHead>
                <TableHead>상태</TableHead>
                <TableHead className="text-right">사용 크레딧</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <button
                      className="job-link"
                      onClick={() => setSelected(j.id)}
                    >
                      <span className="doc-icon">
                        <FileText size={18} />
                      </span>
                      <span>
                        {j.title}
                        <small>
                          {j.documents.length}개 문서 · {date(j.createdAt)}
                        </small>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className="progress-cell">
                      <Progress value={progress(j)} aria-label="작업 진행률" />
                      <span>{progress(j)}%</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge value={j.status} />
                  </TableCell>
                  <TableCell className="text-right mono">
                    {j.spent} <span className="muted">/ {j.budget} CR</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </>
    ) : (
      <div className="empty">
        <Layers3 size={32} />
        <h3>{filtering ? "검색 결과가 없습니다" : "첫 번째 작업을 만들어보세요"}</h3>
        <p>{filtering ? "다른 작업 이름을 검색하거나 검색어를 지워 전체 작업을 확인하세요." : "문서를 넣고 예산을 정하면, 완료된 단계부터 안전하게 기록합니다."}</p>
        <button
          className="text-action"
          onClick={() => filtering ? setSearch("") : openNew(mode === "demo")}
        >
          {filtering ? "검색어 지우기" : mode === "demo" ? "예제 문서로 시작" : "작업 만들기"}{" "}
          <ArrowRight size={16} />
        </button>
      </div>
    );
  }
  function renderAdminLogin() {
    return (
      <>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: adminToken }),
              });
              if (r.ok) {
                setAdminToken("");
                await load();
              } else setError("관리자 키를 확인하세요.");
            } catch {
              setError(
                "서버에 연결할 수 없습니다. 실행 상태를 확인하세요.",
              );
            }
          }}
        >
          <label>
            관리자 키
            <input
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button className="primary">로그인</button>
        </form>
        <details className="setup-requirements"><summary>관리자 키는 어디에 있나요?</summary><p>기본 위치는 서버 폴더의 <code>.relay/admin-key.txt</code>입니다. 별도 데이터 폴더를 설정했다면 서버 실행 로그의 <code>Administrator key file:</code>에 표시된 경로에서 확인하세요. 자동 연결이 만료되면 키로 로그인하세요. 새 자동 연결을 열려면 기존 Relay 실행 창을 닫은 뒤 다시 실행해야 합니다.</p></details>
        {error && error !== "로그인이 필요합니다." && (
          <p className="danger" role="alert">
            {error}
          </p>
        )}
      </>
    );
  }
  return (
    <SidebarProvider>
      <Toaster richColors theme="system" position="top-center" />
      <Sidebar>
        <SidebarHeader>
          <a className="brand" href="/">
            <span className="brand-mark">
              <Layers3 />
            </span>{" "}
            Relay
          </a>
          <div className="pool">
            <span className="pool-icon">
              <Server size={18} />
            </span>
            <span>
              공유 GPU 컴퓨트<small>LLM 실행 · GPU 제공</small>
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <WorkspaceNavigation
            section={section}
            operator={!!data}
            onProvide={openConnectionSetup}
            onChange={(label) => {
              setSection(label);
              setSearch("");
            }}
          />
          <div className="sidebar-note">
            <ShieldCheck size={19} />
            <b>실행은 참여자의 GPU에서</b>
            <p>
              모델과 GPU를 선택하고 실행하세요. 입력 내용은 선택한 GPU 제공자에게 전달됩니다.
            </p>
          </div>
        </SidebarContent>
        <SidebarFooter>
          <div className="small muted">Relay 0.2 · 자체 운영</div>
          <div className="small muted">각자의 PC, 하나의 작업 공간</div>
        </SidebarFooter>
      </Sidebar>
      <a className="skip-link" href="#workspace-content">
        본문으로 건너뛰기
      </a>
      <main className="workspace" id="workspace-content" tabIndex={-1}>
        <header>
          <span>
            <SidebarTrigger aria-label="사이드바 열기 또는 닫기" />{" "}
            <span className="breadcrumb">
              나의 풀 <em>/</em>
            </span>{" "}
            <span className="workspace-section">{section}</span>
          </span>
          <span>
            <button className="secondary member-header-link" onClick={openConnectionSetup}><Wallet size={16} /> 내 GPU·토큰</button>
            <span className="private">
              <Server size={14} /> 독립 서버
            </span>
            {data && (
              <button
                className="icon-button"
                aria-label="로그아웃"
                title="로그아웃"
                onClick={async () => {
                  if (signingOut.current) return;
                  signingOut.current = true;
                  setLoggingOut(true);
                  sessionEpoch.current++;
                  refreshAfterMutation.current = false;
                  setBusy(false);
                  invalidateReads();
                  try {
                    const response = await fetch("/api/logout", {
                      method: "POST",
                    });
                    if (!response.ok)
                      throw Error("로그아웃하지 못했습니다. 다시 시도하세요.");
                    clearAuthentication();
                  } catch {
                    toast.error(
                      "서버 연결을 확인한 뒤 로그아웃을 다시 시도하세요.",
                    );
                  } finally {
                    signingOut.current = false;
                    setLoggingOut(false);
                  }
                }}
              >
                <LogOut size={18} />
              </button>
            )}
          </span>
        </header>
        <div className="content">
          <div className="topline">
            <div className="workspace-label" data-connection={connection} role="status">
              <span className="connection-dot" />{" "}
              <span>{connection === "disconnected" ? "서버 연결 끊김" : connection === "checking" ? "서버 연결 중…" : "스케줄러 연결됨"}</span>
              {connection !== "connected" && lastUpdated && <span> · 마지막 갱신 {date(lastUpdated)}</span>}
            </div>
            {section !== "분산 LLM" && section !== "LLM 실행" && <div className="mode-tabs" role="group" aria-label="실행 환경">
              {[
                ["demo", "체험 풀"],
                ["live", "실제 실행"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  data-state={mode === value ? "active" : "inactive"}
                  onClick={() => {
                    setMode(value);
                    setSelected(null);
                    setModelId("");
                    setAllowed([]);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>}
          </div>
          {section !== "LLM 실행" && <div className="heading">
            <div>
              <h1>
                {section === "워크스페이스" ? "나의 워크스페이스" : section}
              </h1>
              <p>
                {section === "시작하기"
                  ? "몇 가지 선택으로 준비하고, 나머지는 자동으로."
                  : section === "분산 LLM"
                  ? "여러 GPU에 나눈 하나의 모델로 대화하고, 그룹별 메모리와 실행 상태를 확인하세요."
                  : section === "워크스페이스"
                  ? "각자의 컴퓨터에서 실행하고, 하나의 공간에서 이어가세요."
                  : section === "GPU 노드"
                    ? "승인한 컴퓨터에서만 추론합니다. 필요할 때 제공을 중단하세요."
                    : section === "크레딧 원장"
                      ? "무엇을 예약하고, 누구의 기여를 정산했는지 확인하세요."
                      : section === "설계와 운영"
                        ? "핵심 약속과 검증해야 할 한계를 분명하게."
                        : "문서별 진행과 결과, 사용한 크레딧을 확인하세요."}
              </p>
            </div>
            {section !== "설계와 운영" && section !== "시작하기" && section !== "분산 LLM" && (
              <button
                className="primary"
                disabled={!data || busy}
                onClick={() =>
                  section === "GPU 노드"
                    ? mode === "live"
                      ? models.length ? setModal("node") : setSection("시작하기")
                      : toast.info("체험 노드 3대가 준비되어 있습니다.")
                    : openNew()
                }
              >
                <Plus size={17} />
                {section === "GPU 노드" ? "노드 연결" : "새 작업"}
              </button>
            )}
          </div>}
          {section === "LLM 실행" && <ServiceHome onRun={openLlm} onProvide={openConnectionSetup} onDistributed={() => setSection("분산 LLM")} />}
          {section === "LLM 실행" && auth && <details className="operator-entry"><summary>스케줄링 서버 운영자 로그인</summary>{renderAdminLogin()}</details>}
          {error && !auth && (
            <div className="error-banner" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button disabled={connection === "checking"} onClick={() => void load(true)}>{connection === "checking" ? "연결 중…" : "다시 연결"}</button>
            </div>
          )}
          {auth && modal !== "connection" && section !== "LLM 실행" && (
            <div className="card login-card">
              <Cpu />
              <h2>공유 GPU에서 LLM을 실행하세요</h2>
              <p>개인 계정으로 다른 사람의 GPU와 모델을 선택하고 프롬프트를 실행하세요. 이 콘솔의 관리 기능은 운영자 로그인 후 사용할 수 있습니다.</p>
              <button className="primary" onClick={openLlm}>GPU에서 LLM 실행 <ArrowRight size={16} /></button>
              <details className="operator-login">
                <summary>스케줄링 서버 운영자 로그인</summary>
                <p>서비스 운영과 보안 관리를 위한 관리자 전용 로그인입니다. 서버 PC에서는 <b>START-RELAY.cmd</b>로 자동 로그인할 수 있습니다.</p>
                {renderAdminLogin()}
              </details>
            </div>
          )}
          {data && (
            <>
              {section !== "분산 LLM" && section !== "LLM 실행" && <div className={"mode-banner " + mode}>
                <span className="mode-label">
                  {mode === "demo" ? "체험 환경" : "실제 실행 환경"}
                </span>
                <span>
                  {mode === "demo"
                    ? "가상 PC로 작업 흐름을 확인합니다. 실제 GPU나 LLM을 사용하지 않으며, 실제 실행과 크레딧이 분리됩니다."
                    : "문서는 승인한 PC에 전달됩니다. 중앙 서버는 작업 배정·검증·정산을 담당하며, PC가 연결되면 추론을 시작합니다."}
                </span>
              </div>}
              {!loggingOut && <div hidden={section !== "분산 LLM"}><InferencePanel onUnauthorized={clearAuthentication} /></div>}
              {section === "시작하기" && (
                <SetupGuide mode={mode} models={models} nodes={nodes} busy={busy || setupDownloading}
                  onDemo={openDemo} onLive={openConnectionSetup}
                  onModel={() => setModal("model")} onNode={() => setModal("node")}
                  onCreate={() => openNew()} onNodes={() => setSection("GPU 노드")}
                  onDownload={() => void downloadSetup()} />
              )}
              {section === "워크스페이스" && (
                <>
                  <div className="stats">
                    <div>
                      <span>진행 중인 작업</span>
                      <strong>
                        {
                          jobs.filter((j: Any) =>
                            ["queued", "running"].includes(j.status),
                          ).length
                        }
                        <small>개</small>
                      </strong>
                      <small>
                        완료{" "}
                        {
                          jobs.filter((j: Any) => j.status === "completed")
                            .length
                        }{" "}
                        · 부분 완료{" "}
                        {jobs.filter((j: Any) => j.status === "partial").length}
                      </small>
                    </div>
                    <div>
                      <span>
                        {mode === "demo"
                          ? "제공 중인 체험 노드"
                          : "연결된 실제 GPU"}
                      </span>
                      <strong>
                        {
                          nodes.filter(
                            (n: Any) =>
                              n.connected &&
                              n.status === "online" &&
                              !n.revoked,
                          ).length
                        }
                        <small>/ {nodes.length} 대</small>
                      </strong>
                      <small>작업 중에도 소유자 회수 가능</small>
                    </div>
                    <div>
                      <span>사용 가능 크레딧</span>
                      <strong>
                        {fmt(b.available)}
                        <small>CR</small>
                      </strong>
                      <small>예약 {fmt(b.reserved)} CR</small>
                    </div>
                  </div>
                  <div className="grid-main">
                    <article className="card work-card">
                      <div className="card-head">
                        <h2>최근 작업</h2>
                        <button
                          className="text-action"
                          onClick={() => setSection("작업")}
                        >
                          전체 보기 <ArrowUpRight size={15} />
                        </button>
                      </div>
                      {jobTable(jobs.slice(0, 4))}
                    </article>
                    <article className="card computer-card">
                      <div className="card-head">
                        <h2>참여 컴퓨터</h2>
                        <Monitor size={19} className="muted" />
                      </div>
                      <div className="computer-list">
                        {nodes.slice(0, 3).map((n: Any) => (
                          <button
                            key={n.id}
                            className="computer-row"
                            onClick={() => setSection("GPU 노드")}
                          >
                            <span className="computer-icon">
                              <Monitor size={21} />
                            </span>
                            <span>
                              <b>{n.name}</b>
                              <small>
                                {n.revoked
                                  ? "키 폐기"
                                  : n.status === "paused"
                                    ? "일시 정지"
                                    : !n.connected
                                      ? "연결 대기"
                                      : "제공 중"}{" "}
                                · {mode === "demo" ? "가상 PC" : "로컬 추론"}
                              </small>
                            </span>
                            <ArrowRight size={15} />
                          </button>
                        ))}
                        {!nodes.length && (
                          <p className="body-note muted">
                            등록된 컴퓨터가 없습니다. 모델과 PC를 승인하면
                            연결할 수 있습니다.
                          </p>
                        )}
                      </div>
                      <button
                        className="text-action"
                        onClick={() => setSection("GPU 노드")}
                      >
                        컴퓨터 관리 <ArrowRight size={15} />
                      </button>
                    </article>
                  </div>
                  <article className="card execution-map">
                    <div className="map-heading">
                      <h2>작업은 서버에서, 추론은 각자의 PC에서.</h2>
                      <span className="muted">
                        {mode === "demo" ? "체험 흐름" : "독립 실행 구조"}
                      </span>
                    </div>
                    <div className="map-flow">
                      <div className="map-step">
                        <span className="map-icon">
                          <FileText />
                        </span>
                        <span>
                          <b>문서 제출</b>
                          <small>항목과 예산 설정</small>
                        </span>
                      </div>
                      <ArrowRight className="map-arrow" aria-hidden="true" />
                      <div className="map-step map-coordinator">
                        <span className="map-icon">
                          <Server />
                        </span>
                        <span>
                          <b>중앙 스케줄러</b>
                          <small>배정 · 재시도 · 정산</small>
                        </span>
                      </div>
                      <ArrowRight className="map-arrow" aria-hidden="true" />
                      <div className="map-step">
                        <span className="map-icon">
                          <Monitor />
                        </span>
                        <span>
                          <b>참여자 컴퓨터</b>
                          <small>로컬 모델로 문서 추론</small>
                        </span>
                      </div>
                      <ArrowRight className="map-arrow" aria-hidden="true" />
                      <div className="map-step">
                        <span className="map-icon">
                          <Check />
                        </span>
                        <span>
                          <b>결과 보존</b>
                          <small>근거 확인 · 내보내기</small>
                        </span>
                      </div>
                    </div>
                  </article>
                  <div className="bottom-grid">
                    <article className="card">
                      <div className="card-head">
                        <h2>최근 활동</h2>
                        <Activity size={18} className="muted" />
                      </div>
                      {b.events.length ? (
                        <div className="events">
                          {b.events.slice(0, 5).map((e: Any) => (
                            <div key={e.id}>
                              <span className={"event-icon " + e.kind}>
                                {e.kind === "recovery" ? (
                                  <RefreshCw size={14} />
                                ) : e.kind === "success" ? (
                                  <Check size={14} />
                                ) : (
                                  <Clock size={14} />
                                )}
                              </span>
                              <span>
                                {e.message}
                                <small>{date(e.at)}</small>
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted body-note">
                          작업을 제출하면 실행과 복구 기록이 이곳에 쌓입니다.
                        </p>
                      )}
                    </article>
                    <article className="card trust-card">
                      <ShieldCheck size={22} />
                      <h2>중단되어도 이어집니다.</h2>
                      <p>
                        완료된 결과는 보존합니다. 중단된 호출만 다시 배정하고,
                        한 작업의 기여는 한 번만 정산합니다.
                      </p>
                      <button
                        className="text-action"
                        onClick={() => setSection("설계와 운영")}
                      >
                        운영 원칙 보기 <ArrowRight size={15} />
                      </button>
                    </article>
                  </div>
                </>
              )}
              {section === "작업" && (
                <article className="card">
                  <div className="card-head">
                    <h2>작업 {jobs.length}개</h2>
                    <input
                      className="search"
                      aria-label="작업 이름 검색"
                      placeholder="작업 이름 검색"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {jobTable(
                    jobs.filter((j: Any) =>
                      j.title.toLowerCase().includes(search.trim().toLowerCase()),
                    ),
                    !!search.trim(),
                  )}
                </article>
              )}
              {section === "GPU 노드" && (
                <>
                  <div className="section-toolbar">
                    <p className="muted">
                      노드당 1개 실행 · 회수 시 미완료 단계만 재배치
                    </p>
                    {mode === "live" && (
                      <button
                        className="secondary"
                        onClick={() => setModal("model")}
                      >
                        <Plus size={16} /> 승인 모델 등록
                      </button>
                    )}
                  </div>
                  <div className="nodes-grid">
                    {nodes.map((n: Any) => {
                      const active = jobs
                        .flatMap((j: Any) => j.tasks)
                        .find((t: Any) => t.lease?.nodeId === n.id);
                      return (
                        <article className="card node-card" key={n.id}>
                          <div className="card-head">
                            <span className="node-symbol">
                              <Cpu />
                            </span>
                            <Badge
                              value={
                                n.revoked
                                  ? "키 폐기"
                                  : n.status === "paused"
                                    ? "일시 정지"
                                    : !n.connected
                                      ? "연결 대기"
                                      : active
                                        ? "leased"
                                        : "passed"
                              }
                            />
                          </div>
                          <h2>{n.name}</h2>
                          <p className="muted">
                            {mode === "demo"
                              ? "가상 제공자 · 실제 GPU 아님"
                              : fmt(n.vram) + " MiB · llama.cpp"}
                          </p>
                          <div className="node-model">
                            <Layers3 size={15} />
                            {models.find((m: Any) => m.id === n.model)?.name}
                          </div>
                          <div className="node-metrics">
                            <div>
                              <strong>{n.completed}</strong>
                              <small>완료 단계</small>
                            </div>
                            <div>
                              <strong>
                                {n.earned}
                                <span> CR</span>
                              </strong>
                              <small>기여 크레딧</small>
                            </div>
                          </div>
                          {active && (
                            <div className="running-bar">
                              <span /> 문서 추출 중 · 시도{" "}
                              {active.attempts.length}
                            </div>
                          )}
                          <button
                            className="secondary full"
                            disabled={busy || n.revoked}
                            onClick={() =>
                              run(
                                n.status === "paused" ? "resume" : "pause",
                                { nodeId: n.id },
                                "노드 상태를 변경했습니다.",
                              )
                            }
                          >
                            {n.status === "paused" ? (
                              <Play size={15} />
                            ) : (
                              <Pause size={15} />
                            )}{" "}
                            {n.status === "paused" ? "제공 재개" : "즉시 회수"}
                          </button>
                          {mode === "live" && !n.revoked && (
                            <button
                              className="text-action danger"
                              onClick={() =>
                                setConfirm({
                                  action: "revoke",
                                  payload: { nodeId: n.id },
                                  title: "노드 키를 폐기할까요?",
                                  description:
                                    "현재 할당을 철회하고 이 키의 모든 요청을 차단합니다.",
                                })
                              }
                            >
                              인증 키 폐기
                            </button>
                          )}
                        </article>
                      );
                    })}
                  </div>
                  {!nodes.length && (
                    <div className="card empty">
                      <Cpu size={34} />
                      <h3>아직 연결된 노드가 없습니다</h3>
                      <p>설정 도우미에서 파일을 선택하고 안내에 따라 연결하세요.</p>
                      <button
                        className="text-action"
                        onClick={() => { setMode("live"); setSection("시작하기"); }}
                      >
                        PC 연결 시작하기 <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
                  <div className="card connection-guide">
                    <h2>클릭으로 PC 연결하기</h2>
                    <ol>
                      <li>
                        PC 설정 도우미에서 모델 파일을 선택하세요. 파일 확인 정보는 자동으로 계산합니다.
                      </li>
                      <li>
                        웹에서 PC를 등록하고 연결 설정을 저장하세요.
                      </li>
                      <li>
                        도우미에 연결 설정을 가져온 뒤 참여 시작을 누르세요.
                      </li>
                    </ol>
                    <p>
                      즉시 회수는 서버의 실행 권한을 철회합니다. 제공자는 다음
                      확인 때 자신이 시작한 추론 프로세스를 종료합니다. 실제
                      메모리 반환 시간은 장비에서 확인해야 합니다.
                    </p>
                    <button onClick={() => void downloadSetup()} disabled={setupDownloading} className="text-action">
                      <Download size={16} /> PC 설정 도우미 받기
                    </button>
                  </div>
                </>
              )}
              {section === "크레딧 원장" && (
                <>
                  {mode === "live" && <MemberAllocations />}
                  <div className="stats">
                    {[
                      ["사용 가능", b.available],
                      ["예약 중", b.reserved],
                      [
                        "누적 확정 지출",
                        b.ledger
                          .filter((l: Any) => l.type === "settlement")
                          .reduce((a: number, l: Any) => a + l.amount, 0),
                      ],
                    ].map(([s, n]) => (
                      <div key={s}>
                        <span>{s}</span>
                        <strong>
                          {fmt(n)}
                          <small>CR</small>
                        </strong>
                      </div>
                    ))}
                  </div>
                  <div className="tariff">
                    <ShieldCheck size={22} />
                    <div>
                      <b>문서당 10 CR · 제공자 9 + 운영 1</b>
                      <p>
                        고정 요율 document-v1. 토큰 자가보고에 과금하지
                        않습니다. 품질과 실행 정산은 따로 기록합니다.
                      </p>
                    </div>
                  </div>
                  <article className="card">
                    <div className="card-head">
                      <h2>정산 기록</h2>
                      <button
                        className="text-action"
                        onClick={() =>
                          save(
                            "relay-ledger-" + mode + ".json",
                            JSON.stringify(
                              {
                                mode,
                                accounts: b.accounts,
                                issued: b.issued,
                                reserved: b.reserved,
                                ledger: b.ledger,
                              },
                              null,
                              2,
                            ),
                          )
                        }
                      >
                        <Download size={16} /> 내보내기
                      </button>
                    </div>
                    <div className="table-wrap">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>시각 / 영수증</TableHead>
                            <TableHead>내용</TableHead>
                            <TableHead>제공자</TableHead>
                            <TableHead>운영</TableHead>
                            <TableHead className="text-right">크레딧</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[...b.ledger].reverse().map((l: Any) => (
                            <TableRow key={l.id}>
                              <TableCell>
                                {date(l.at)}
                                <small className="cell-small mono">
                                  {l.id.slice(0, 8)}
                                </small>
                              </TableCell>
                              <TableCell>
                                {l.type === "grant"
                                  ? "시작 보조금 발행"
                                  : (b.jobs.find((j: Any) => j.id === l.jobId)
                                      ?.title ?? "문서 추출")}
                                <small className="cell-small">
                                  {l.type === "grant"
                                    ? "1회 · 별도 발행 계정"
                                    : labels[l.quality]}
                                </small>
                              </TableCell>
                              <TableCell>{l.provider ?? "—"}</TableCell>
                              <TableCell>{l.operator ?? "—"}</TableCell>
                              <TableCell className="text-right mono">
                                {l.type === "grant" ? "+" : "−"}
                                {l.amount} CR
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </article>
                  <p className="footnote">
                    현금으로 환전하거나 양도할 수 없는 풀 내부 사용권입니다.
                    체험·실제 원장은 서로 이전되지 않습니다.
                  </p>
                </>
              )}
              {section === "설계와 운영" && (
                <>
                  <div className="architecture-banner">
                    <Layers3 size={28} />
                    <div>
                      <h2>내 서버가 조정하고, 참여 PC가 실행합니다</h2>
                      <p>
                        브라우저 → 독립 스케줄링 서버 → 참여자 PC의 llama.cpp →
                        결과 검증과 원장
                      </p>
                    </div>
                  </div>
                  <div className="review-grid">
                    {[
                      [
                        "01",
                        "재시도와 정산을 분리",
                        "실행은 여러 번 일어날 수 있습니다. 시도 번호와 만료 시각으로 오래된 결과를 차단하고 결과·지급·예약 해제를 하나의 저장 전이로 확정합니다.",
                      ],
                      [
                        "02",
                        "잔액과 작업 예산을 함께 검사",
                        "여러 작업이 같은 잔액을 중복 예약하지 못합니다. 정수 크레딧과 고정 요율을 사용하며 취소·실패 시 미사용 예약을 해제합니다.",
                      ],
                      [
                        "03",
                        "출처를 확인 가능한 결과",
                        "제출 원문과 해시를 보존하고 인용문이 실제 원문에 있는지 검사합니다. 의미적 정확성은 사람의 검토가 필요합니다.",
                      ],
                      [
                        "04",
                        "승인 모델로 추론만 실행",
                        "모델·실행파일·템플릿을 고정합니다. 제공자는 문서 속 셸·도구 실행 지시를 실행하지 않습니다. 원격 실행의 진위는 제공자에 대한 신뢰에 의존합니다.",
                      ],
                      [
                        "05",
                        "품질 개선에는 별도 비용",
                        "완료된 실행은 약정 요율로 정산합니다. 품질 재호출은 새로운 단계와 예약을 만들며 기존 지급을 지우지 않습니다.",
                      ],
                      [
                        "06",
                        "작은 풀에 맞춘 저장 구조",
                        "상태 버전으로 동시 갱신을 보호합니다. 최대 20개 노드, 원문·결과를 유지하는 작업 24개, 작업당 문서 4개입니다. 대규모 운영 전 테이블 분리와 계측이 필요합니다.",
                      ],
                    ].map(([n, t, p]) => (
                      <article className="card review-card" key={n}>
                        <h2>{t}</h2>
                        <p>{p}</p>
                      </article>
                    ))}
                  </div>
                  <article className="card limits">
                    <h2>독립 운영과 현재 범위</h2>
                    <p>
                      특정 플랫폼 계정이나 클라우드 API 없이 실행합니다. 중앙
                      서버는 GPU가 필요 없으며, 브라우저를 닫아도 기한과 실행
                      권한을 관리합니다. 참여 PC는 서버에 작업을 요청하므로
                      외부에서 PC로 연결할 포트를 열 필요가 없습니다.
                    </p>
                    <p>
                      개인은 자기 계정으로 GPU를 제공하고 토큰을 얻거나 다른 GPU를 이용합니다.
                      운영자는 서비스와 보안을 관리합니다. 현재 단일 풀을 사용하며 중앙 서버에 문서와 결과가
                      저장되므로 공개 데이터만 제출하세요.
                    </p>
                    <p>
                      실물 GPU 3대 이상과 여러 네트워크에서 처리 시간, 전력,
                      메모리 반환, 모델 품질을 측정해야 합니다. 체험 결과는 성능
                      실측이나 실행 진위 증명이 아닙니다.
                    </p>
                    <p>
                      문서 추출 작업은 문서별로 실행하고 검증된 항목을 병합합니다.
                      여러 GPU로 하나의 모델을 실행하려면 운영자가 준비한 분산 LLM을 사용하세요.
                      개인 계정은 가입 후 GPU 제공과 이용이 가능합니다. GPU 간 생성 상태의 직접 이동,
                      임의 작업 그래프, 현금 정산은 제공하지 않습니다.
                    </p>
                    <p>
                      공급이 없으면 대기합니다. 기한 경과 시 부분 결과와 실패
                      이유를 보존하며 처리량이나 가동 시간을 보장하지 않습니다.
                    </p>
                  </article>
                </>
              )}
            </>
          )}
          {!data && !auth && !error && (
            <div className="card empty">
              <RefreshCw className="spin" />
              <p>내 풀을 불러오는 중입니다.</p>
            </div>
          )}
        </div>
      </main>

      <ParticipantPanel open={modal === "connection"} initialTab={memberTab} onOpenChange={(value) => { if (!value) { connectionFlow.current = false; setModal(null); if (["#run-llm", "#connect-pc"].includes(window.location.hash)) window.history.replaceState(null, "", window.location.pathname + window.location.search); } }} />
      <Dialog open={newOpen} onOpenChange={(value) => { if (!creatingJob.current) setNewOpen(value); }}>
        <DialogContent className="wide-dialog">
          <DialogHeader>
            <DialogTitle>새 문서 추출 작업</DialogTitle>
            <DialogDescription>
              공개 문서에서 필요한 항목과 근거를 추출합니다. 문서당 10 CR을
              예약합니다.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={create} className="form">
            <div className="form-row">
              <label>
                작업 이름
                <input
                  required
                  maxLength={100}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="예: 공개 기술 문서 비교"
                />
              </label>
              <label>
                실행 모델
                <Select
                  value={modelId || models[0]?.id || ""}
                  onValueChange={value => { setModelId(value); setAllowed([]); }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="승인 모델 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m: Any) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <label>
              사용할 크레딧 계정
              <Select value={payer} onValueChange={setPayer}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="requester">
                    내 요청 계정 · {fmt(b?.available ?? 0)} CR
                  </SelectItem>
                  {nodes.map((n: Any) => (
                    <SelectItem key={n.id} value={n.account}>
                      {n.name} 기여 계정 ·{" "}
                      {fmt(b?.accountAvailable?.[n.account] ?? 0)} CR
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label>
              추출 항목 <small>쉼표로 구분 · 최대 6개</small>
              <input
                required
                value={fields}
                onChange={(e) => setFields(e.target.value)}
              />
            </label>
            <div className="form-section-head">
              <b>문서 {documents.length} / 4</b>
              <div>
                <input
                  type="file"
                  accept=".txt,.md,.jsonl"
                  multiple
                  ref={fileInput}
                  hidden
                  onChange={(e) => void upload(e.target.files)}
                />
                <button
                  type="button"
                  className="text-action"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={15} /> 가져오기
                </button>
                {mode === "demo" && (
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => {
                      setDocuments(samples);
                      if (!title) setTitle("공개 기술 문서 비교");
                    }}
                  >
                    예제 불러오기
                  </button>
                )}
              </div>
            </div>
            {documents.map((d, i) => (
              <div className="document-input" key={i}>
                <div className="form-row">
                  <label>
                    문서 {i + 1} 제목
                    <input
                      required
                      value={d.title}
                      maxLength={120}
                      onChange={(e) =>
                        setDocuments((ds) =>
                          ds.map((x, k) =>
                            k === i ? { ...x, title: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    출처 URL <small>선택</small>
                    <input
                      type="url"
                      value={d.url}
                      onChange={(e) =>
                        setDocuments((ds) =>
                          ds.map((x, k) =>
                            k === i ? { ...x, url: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="https://"
                    />
                  </label>
                </div>
                <label>
                  원문 <small>{d.text.length.toLocaleString()} / 4,000자</small>
                  <textarea
                    required
                    maxLength={4000}
                    rows={4}
                    value={d.text}
                    onChange={(e) =>
                      setDocuments((ds) =>
                        ds.map((x, k) =>
                          k === i ? { ...x, text: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </label>
                {documents.length > 1 && (
                  <button
                    type="button"
                    className="text-action danger"
                    onClick={() =>
                      setDocuments((ds) => ds.filter((_, k) => i !== k))
                    }
                  >
                    <X size={14} /> 문서 삭제
                  </button>
                )}
              </div>
            ))}
            {documents.length < 4 && (
              <button
                type="button"
                className="secondary"
                onClick={() => setDocuments((ds) => [...ds, emptyDoc()])}
              >
                <Plus size={15} /> 문서 추가
              </button>
            )}
            <div className="form-row">
              <label>
                전체 예산 상한 (CR)
                <input
                  type="number"
                  min={documents.length * 10}
                  max={1000}
                  required
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </label>
              <label>
                완료 기한 (분)
                <input
                  type="number"
                  min={1}
                  max={1440}
                  required
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>
            </div>
            <fieldset className="allow-nodes">
              <legend>
                허용 제공자 <small>선택하지 않으면 이 모델을 지원하는 모든 승인 노드</small>
              </legend>
              {allowed.length > 0 && (
                <button type="button" className="quiet" onClick={() => setAllowed([])}>
                  제공자 선택 초기화
                </button>
              )}
              {nodes
                .filter((n: Any) => !n.revoked && n.model === (modelId || models[0]?.id))
                .map((n: Any) => (
                  <label className="check-label" key={n.id}>
                    <Checkbox
                      checked={allowed.includes(n.id)}
                      onCheckedChange={(v) =>
                        setAllowed((a) =>
                          v ? [...a, n.id] : a.filter((x) => x !== n.id),
                        )
                      }
                    />
                    {n.name}
                  </label>
                ))}
            </fieldset>
            <label className="check-label consent">
              <Checkbox
                checked={publicData}
                onCheckedChange={(v) => setPublicData(v === true)}
              />
              제공자가 내용을 볼 수 있는 공개·비민감 문서입니다.
            </label>
            <div className="form-footer">
              <span>
                지금 예약 <b>{documents.length * 10} CR</b>
                <small>미사용 예약은 해제됩니다.</small>
              </span>
              <button
                className="primary"
                disabled={busy || !publicData || !models.length}
              >
                <Play size={16} />
                {busy ? "제출 중…" : "작업 실행"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!job}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      >
        <DialogContent className="wide-dialog detail-dialog">
          {job && (
            <>
              <DialogHeader>
                <DialogTitle>{job.title}</DialogTitle>
                <DialogDescription>
                  {job.documents.length}개 문서 ·{" "}
                  {mode === "demo" ? "규칙 기반 체험" : "llama.cpp"} ·{" "}
                  {job.model.name}
                </DialogDescription>
              </DialogHeader>
              <div className="detail-meta">
                <Badge value={job.status} />
                <span>
                  {job.spent} / {job.budget} CR
                </span>
                <span>예약 {job.reserved} CR</span>
                <span>기한 {date(job.deadline)}</span>
              </div>
              <div className="detail-progress">
                <Progress value={progress(job)} />
                <b>{progress(job)}%</b>
              </div>
              <div className="detail-pipeline">
                <span>01 문서별 추출</span>
                <ArrowRight size={16} />
                <span>02 출처 검증</span>
                <ArrowRight size={16} />
                <span>03 결과 병합</span>
              </div>
              {job.documents.map((d: Any) => {
                const t = job.tasks.find((t: Any) => t.id === d.taskId);
                return (
                  <article className="result-card" key={d.id}>
                    <div className="card-head">
                      <h3>
                        <FileText size={17} />
                        {d.title}
                      </h3>
                      <Badge value={t.status} />
                    </div>
                    <p className="result-meta">
                      시도 {t.attempts.length}회{" "}
                      {t.quality !== "pending" && "· " + labels[t.quality]}{" "}
                      {t.reason && "· " + t.reason}
                    </p>
                    {t.status === "leased" && (
                      <div className="inline-notice">
                        <Activity size={16} />
                        {nodes.find((n: Any) => n.id === t.lease.nodeId)?.name}
                        에서 실행 중
                        <button
                          className="text-action"
                          disabled={busy}
                          onClick={() =>
                            run(
                              "pause",
                              { nodeId: t.lease.nodeId },
                              "노드를 회수했습니다. 다른 노드가 남은 단계를 이어받습니다.",
                            )
                          }
                        >
                          {mode === "demo"
                            ? "노드 회수 체험"
                            : "노드 즉시 회수"}{" "}
                          <Pause size={14} />
                        </button>
                      </div>
                    )}
                    {t.status === "ready" && (
                      <p className="body-note muted">
                        동일한 모델과 실행 환경을 가진 승인 제공자를 기다립니다.
                      </p>
                    )}
                    {t.items && (
                      <div className="extracted">
                        {t.items.map((v: Any) => (
                          <div key={v.field}>
                            <b>{v.field}</b>
                            <span>
                              {v.value ?? <i className="muted">근거 없음</i>}
                              {v.quote && (
                                <details>
                                  <summary>원문 근거 확인</summary>
                                  <blockquote>{v.quote}</blockquote>
                                  <small>
                                    원문 위치 {v.start}–{v.end} · UTF-16
                                  </small>
                                </details>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <details className="source-text">
                      <summary>
                        제출 원문 · SHA-256 {d.hash.slice(0, 12)}…
                      </summary>
                      {d.url && (
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {d.url} <ArrowUpRight size={13} />
                        </a>
                      )}
                      <pre>{d.text}</pre>
                    </details>
                    {["failed", "settled"].includes(t.status) &&
                      t.quality !== "passed" &&
                      job.status !== "cancelled" && (
                        <button
                          className="text-action"
                          disabled={busy}
                          onClick={() =>
                            run(
                              "retry",
                              { jobId: job.id, documentId: d.id },
                              "새 단계로 10 CR을 예약했습니다.",
                            )
                          }
                        >
                          <RefreshCw size={14} /> 이 문서 다시 추출 · 10 CR 예약
                        </button>
                      )}
                  </article>
                );
              })}
              <div className="detail-actions">
                <div>
                  {["jsonl", "csv", "md"].map((f) => (
                    <button
                      className="secondary"
                      key={f}
                      onClick={() => exportJob(job, f)}
                    >
                      <Download size={14} />
                      {f === "md" ? "Markdown" : f.toUpperCase()}
                    </button>
                  ))}
                </div>
                {["queued", "running"].includes(job.status) ? (
                  <button
                    className="text-action danger"
                    onClick={() =>
                      setConfirm({
                        action: "cancel",
                        payload: { jobId: job.id },
                        title: "작업을 취소할까요?",
                        description:
                          "미완료 단계의 실행 권한과 예약을 해제합니다. 확정 결과와 지급은 유지합니다.",
                      })
                    }
                  >
                    작업 취소
                  </button>
                ) : (
                  <button
                    className="text-action"
                    onClick={() =>
                      setConfirm({
                        action: "archive",
                        payload: { jobId: job.id },
                        title: "원문·결과 삭제",
                        description:
                          "원문과 추출 결과를 영구 삭제하고 목록에서 제거합니다. 복구할 수 없으며 정산 기록만 유지됩니다. 필요한 결과는 돌아가서 JSONL, CSV 또는 Markdown으로 먼저 저장하세요. 이 버튼은 파일을 저장하지 않습니다.",
                      })
                    }
                  >
                    <Trash2 size={14} /> 원문·결과 삭제
                  </button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={modal === "model"}
        onOpenChange={(v) => { if (!v) setModal(connectionFlow.current ? "connection" : null); }}
      >
        <DialogContent className="wide-dialog">
          <DialogHeader>
            <DialogTitle>모델 준비하기</DialogTitle>
            <DialogDescription>
              PC 설정 도우미에서 저장한 모델 확인 파일을 가져오세요. 파일 확인 값은 자동으로 입력됩니다.
            </DialogDescription>
          </DialogHeader>
          <input ref={contractInput} type="file" accept=".json,application/json" hidden
            onChange={(e) => { void importContract(e.target.files?.[0]); e.target.value = ""; }} />
          <div className="setup-import">
            <FileText size={25} />
            <b>{contractFile || "모델 확인 파일을 선택하세요"}</b>
            <p>{contractFile ? "확인 정보를 가져왔습니다. 아래 설정을 확인하세요." : "도우미에서 파일을 선택하고 파일 검사 → 모델 검증 파일 저장을 누르세요."}</p>
            <button className="secondary" onClick={() => contractInput.current?.click()} disabled={busy}>
              <Upload size={16} /> {contractFile ? "다른 파일 가져오기" : "모델 확인 파일 가져오기"}
            </button>
          </div>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            try {
              const requestId = submissionId(modelSubmission, modeRef.current, "model", modelForm);
              await act("model", modelForm, false, requestId);
              modelSubmission.current = null;
              setModal(connectionFlow.current ? "connection" : null);
              setContractFile("");
              setModelForm({ name: "", digest: "", runtime: "", template: "", context: 8192, minVram: 4096 });
              setManualModel(false);
              toast.success("모델 준비가 끝났습니다. 이제 PC를 등록하세요.");
            } catch { /* The action handler shows errors. */ }
          }}>
            <label>모델 이름
              <input required maxLength={100} placeholder="예: 우리 팀 문서 분석 모델" value={modelForm.name}
                onChange={(e) => setModelForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label>모델에 필요한 GPU 메모리 (GB)
              <input required type="number" min={0} max={195} step={0.5} value={modelForm.minVram / 1024}
                onChange={(e) => setModelForm((f) => ({ ...f, minVram: Number(e.target.value) * 1024 }))} />
              <small>운영자가 모델 실행에 필요한 메모리를 확인해 지정하세요. 자동 측정값이 아닙니다.</small>
            </label>
            <details open={manualModel} onToggle={(e) => setManualModel(e.currentTarget.open)} className="setup-advanced">
              <summary>고급 설정 · 직접 입력</summary>
              <div className="form">
                {(["digest", "runtime", "template"] as const).map((k) => (
                  <label key={k}>{{ digest: "GGUF 파일 SHA-256", runtime: "llama-server 실행파일 SHA-256", template: "chat template SHA-256" }[k]}
                    <input required value={modelForm[k]} maxLength={64} pattern="[a-f0-9]{64}"
                      onChange={(e) => { setContractFile(""); setModelForm((f) => ({ ...f, [k]: e.target.value })); }} />
                  </label>
                ))}
                <label>문맥 길이
                  <input required type="number" min={4096} max={131072} value={modelForm.context}
                    onChange={(e) => setModelForm((f) => ({ ...f, context: Number(e.target.value) }))} />
                  <small>PC 설정 도우미의 문맥 길이와 같아야 합니다.</small>
                </label>
              </div>
            </details>
            <button className="primary" disabled={busy || ![modelForm.digest, modelForm.runtime, modelForm.template].every((v) => /^[a-f0-9]{64}$/.test(v))}>
              <Check size={16} /> {busy ? "모델 확인 중…" : "이 모델 사용하기"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={modal === "node"} onOpenChange={(v) => { if (!v && !creatingNode) setModal(connectionFlow.current ? "connection" : null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>내 PC 등록하기</DialogTitle>
            <DialogDescription>이름을 정하면 연결 설정을 만들어 드립니다. 연결 키와 서버 주소를 직접 입력할 필요가 없습니다.</DialogDescription>
          </DialogHeader>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            if (pairing.current) return;
            pairing.current = true;
            const pairingSession = sessionEpoch.current;
            setCreatingNode(true);
            try {
              const response = await fetch("/api/setup");
              if (pairingSession !== sessionEpoch.current || signingOut.current)
                throw new DOMException("세션이 변경되었습니다.", "AbortError");
              if (response.status === 401) {
                clearAuthentication();
                throw new DOMException("다시 로그인하세요.", "AbortError");
              }
              if (!response.ok) throw Error("서버 연결 정보를 읽지 못했습니다. 다시 로그인하고 시도하세요.");
              const setup = await response.json();
              if (pairingSession !== sessionEpoch.current || signingOut.current || modeRef.current !== "live")
                throw new DOMException("세션이 변경되었습니다.", "AbortError");
              const chosenModel = models.find((m: Any) => m.id === (nodeForm.modelId || models[0]?.id));
              const nodePayload = { ...nodeForm, modelId: chosenModel.id };
              const fingerprint = JSON.stringify({ mode: modeRef.current, ...nodePayload });
              if (nodeCredential.current?.fingerprint !== fingerprint)
                nodeCredential.current = { fingerprint, token: crypto.randomUUID() + crypto.randomUUID() };
              const token = nodeCredential.current.token;
              // Retain the token as well as the ID when a committed registration response is lost.
              // Validate the complete configuration before registering a node.
              connectionConfig({ coordinator: setup.coordinator, credential: { nodeId: "pending", nodeName: nodeForm.name, poolId: data.poolId, token }, model: chosenModel });
              const payload = { ...nodePayload, token };
              const requestId = submissionId(nodeSubmission, modeRef.current, "node", payload);
              const r = await act("node", payload, false, requestId);
              const config = connectionConfig({ coordinator: setup.coordinator, credential: { ...r, nodeName: nodeForm.name, token, poolId: data.poolId }, model: chosenModel });
              setCredential({ ...r, token, poolId: data.poolId, config, localOnly: setup.localOnly });
              setCredentialSaved(false);
              nodeSubmission.current = null;
              nodeCredential.current = null;
              connectionFlow.current = false;
              setModal(null);
              setNodeForm({ name: "", modelId: "", vram: 8192 });
            } catch (e: Any) { if (e.name !== "AbortError") toast.error(e.message); }
            finally { pairing.current = false; setCreatingNode(false); }
          }}>
            <label>PC 이름
              <input required maxLength={80} placeholder="예: 작업실 PC" value={nodeForm.name}
                onChange={(e) => setNodeForm((n) => ({ ...n, name: e.target.value }))} />
            </label>
            <label>사용할 모델
              <Select value={nodeForm.modelId || models[0]?.id || ""} onValueChange={(v) => setNodeForm((n) => ({ ...n, modelId: v }))}>
                <SelectTrigger><SelectValue placeholder="모델 선택" /></SelectTrigger>
                <SelectContent>{models.map((m: Any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label>할당할 GPU 메모리 (GB)
              <input type="number" min={0} max={195} step={0.5} required value={nodeForm.vram / 1024}
                onChange={(e) => setNodeForm((n) => ({ ...n, vram: Number(e.target.value) * 1024 }))} />
              <small>PC에서 사용할 수 있는 메모리를 입력하세요. 연결 후 자동 측정되지는 않습니다.</small>
            </label>
            <button className="primary" disabled={busy || creatingNode || !models.length}>
              {creatingNode ? <RefreshCw className="spin" size={16} /> : <ArrowRight size={16} />}
              {creatingNode ? "연결 설정 준비 중…" : "연결 설정 만들기"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!credential} onOpenChange={(v) => {
        if (!v && credentialSaved) setCredential(null);
        else if (!v) toast.info("연결 키는 다시 표시되지 않습니다. 연결 설정을 먼저 저장하세요.");
      }}>
        <DialogContent className="wide-dialog">
          <DialogHeader>
            <DialogTitle>연결 설정이 준비되었어요</DialogTitle>
            <DialogDescription>연결 설정을 저장하면 PC 도우미가 다운로드한 파일을 자동으로 찾습니다. 파일에는 이 PC의 이름과 개인 연결 키가 포함됩니다.</DialogDescription>
          </DialogHeader>
          {credential && <>
            <ol className="setup-handoff">
              <li><b>1. 연결 설정 저장</b><span>아래 버튼으로 설정 파일을 다운로드하세요. 다른 PC가 참여한다면 해당 PC로 파일을 전달하세요.</span></li>
              <li><b>2. 도우미에서 연결 확인</b><span>도우미를 열면 다운로드 폴더에서 연결 파일을 찾습니다. 이미 열려 있어도 새 파일을 확인합니다. 여러 개라면 서비스 주소와 PC 이름을 보고 선택하세요.</span></li>
              <li><b>3. 참여 시작</b><span>도우미에서 검사하고 참여 시작을 누르면 연결 상태가 자동으로 표시됩니다.</span></li>
            </ol>
            {credential.localOnly && <div className="inline-notice"><Monitor size={18} /> 이 설정은 서버와 같은 PC에서 사용할 수 있습니다. 다른 PC는 운영자가 서버의 HTTPS 주소를 먼저 설정해야 합니다.</div>}
            <div className="setup-actions">
              <button className="primary" onClick={() => {
                const fileId = String(credential.nodeId).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80) || "pc";
                save(`relay-provider-${fileId}.json`, JSON.stringify(credential.config, null, 2), "application/json");
                setCredentialSaved(true);
              }}><Download size={16} /> {credentialSaved ? "연결 설정 다시 저장" : "연결 설정 저장"}</button>
              <button className="secondary" disabled={!credentialSaved} onClick={() => { setCredential(null); setSection("시작하기"); }}>저장했어요 · 연결 확인</button>
            </div>
            <p className="muted small">다른 폴더에 저장했다면 도우미의 ‘연결 폴더 선택’ 또는 ‘연결 파일 불러오기’를 사용하세요. 기존에 선택한 연결은 유지되며, 참여 시작은 직접 눌러야 합니다.</p>
            <p className="muted small">다운로드한 연결 설정은 이 PC의 비밀번호처럼 보관하세요. 키를 잃어버리면 GPU 노드에서 기존 키를 폐기하고 다시 등록하세요.</p>
            <details className="setup-advanced"><summary>연결 정보 직접 확인</summary><label>제공자 키<code className="secret">{credential.token}</code></label><p className="mono credential-id">풀: {credential.poolId}<br />노드: {credential.nodeId}</p></details>
          </>}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v && !busy) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>돌아가기</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              variant={confirm?.action === "archive" ? "destructive" : "default"}
              onClick={async (event) => {
                event.preventDefault();
                const c = confirm;
                if (!c || busy) return;
                if (await run(c.action, c.payload, "처리했습니다.")) {
                  setConfirm(null);
                  if (c.action === "archive") setSelected(null);
                }
              }}
            >
              {busy ? "처리 중…" : confirm?.action === "archive" ? "삭제" : "확인"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
