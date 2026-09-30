import { useId } from "react";
import { ArrowRight, Check, Cpu, Download, FileCheck2, Monitor, Play, RefreshCw, Sparkles } from "lucide-react";
import { setupProgress } from "@/lib/relay/setup.mjs";

type Props = {
  compact?: boolean;
  mode: string;
  models: any[];
  nodes: any[];
  busy: boolean;
  onDemo: () => void;
  onLive: () => void;
  onModel: () => void;
  onNode: () => void;
  onCreate: () => void;
  onNodes: () => void;
  onDownload: () => void;
};

export default function SetupGuide(props: Props) {
  const { compact = false, mode, models, nodes, busy, onDemo, onLive, onModel, onNode, onCreate, onNodes, onDownload } = props;
  const state = setupProgress(models, nodes);
  const stepsTitle = useId();
  return (
    <div className="setup-guide">
      {!compact && <section className="setup-welcome card">
        <div className="setup-eyebrow"><Sparkles size={16} /> 시작은 가볍게</div>
        <h2>하고 싶은 일을 선택하세요.</h2>
        <p>설정은 안내에 따라 한 번만. 작업 배정과 결과 정리는 Relay가 이어서 처리합니다.</p>
        <div className="setup-choices">
          <button className="setup-choice" onClick={onDemo} disabled={busy}>
            <span className="setup-choice-icon"><Play size={24} /></span>
            <span><b>먼저 체험하기</b><small>설치 없이 예제 문서로 흐름을 확인해요.</small><em>실제 GPU를 사용하지 않는 체험</em></span>
            <ArrowRight size={20} />
          </button>
          <button className="setup-choice" onClick={onLive} aria-pressed={mode === "live"} disabled={busy}>
            <span className="setup-choice-icon"><Cpu size={24} /></span>
            <span><b>내 GPU 연결하기</b><small>PC 설정 도우미로 파일을 선택하고 연결해요.</small><em>처음 한 번 준비 · 다음부터 참여 시작</em></span>
            <ArrowRight size={20} />
          </button>
        </div>
      </section>}
      {mode === "live" && (
        <section className="card setup-steps" aria-labelledby={stepsTitle}>
          <div className="card-head">
            <div><h2 id={stepsTitle}>내 PC 연결</h2><p className="muted">파일 확인부터 연결 상태까지, 여기에서 이어가세요.</p></div>
            <span className="status">{state.step} / 3 완료</span>
          </div>
          {!compact && <ol className="setup-step-list">
            {[
              { title: "모델 준비", detail: "PC에서 파일을 선택하고 확인 정보를 가져와요.", done: state.registered, icon: FileCheck2 },
              { title: "PC 등록", detail: "이 PC가 작업을 받을 수 있도록 등록하고 연결 파일을 저장해요.", done: state.paired, icon: Download },
              { title: "참여 시작", detail: "설정 도우미에서 시작하면 연결을 자동 확인해요.", done: state.connected, icon: Monitor },
            ].map(({ title, detail, done, icon: Icon }, index) => (
              <li key={title} data-current={state.step === index} aria-current={state.step === index ? "step" : undefined}>
                <span className={"setup-step-icon " + (done ? "done" : "")}>{done ? <Check size={19} /> : <Icon size={19} />}</span>
                <div><b>{index + 1}. {title}</b><p>{detail}</p><small>{done ? "완료" : state.step === index ? "지금 진행할 단계" : "이어서 진행"}</small></div>
              </li>
            ))}
          </ol>}
          <div className="setup-next" aria-live="polite">
            {state.step === 0 ? <>
              {compact ? <>
                <h3>1. 모델 확인 파일 가져오기</h3>
                <p>PC 설정 도우미에서 <b>파일 검사 → 모델 검증 파일 저장</b>을 누른 뒤, 저장한 파일을 가져오세요. 아직 도우미가 없다면 먼저 내려받으세요.</p>
              </> : <>
              <h3>처음에는 연결 파일이 없어도 괜찮아요.</h3>
              <p><b>연결 파일</b>은 이 PC가 Relay에서 작업을 받기 위한 설정입니다. Relay 주소, 등록된 PC 정보, 비밀 참여 키가 들어 있습니다. 모델을 승인하고 PC를 등록한 뒤 <b>연결 설정 저장</b>으로 만들 수 있어요.</p>
              <p><b>모델</b>은 Qwen 같은 AI의 학습 결과인 가중치 파일이고, <b>llama-server</b>는 그 모델을 이 PC에서 실행하는 프로그램입니다. 둘 다 준비한 뒤 Relay에 연결합니다.</p>
              <p>도우미를 열면 Windows·WSL에 저장된 모델을 자동으로 찾습니다. 목록에서 GGUF 모델을 고르면 내장 템플릿도 준비됩니다. llama-server 실행파일을 확인하고 <b>파일 검사 → 모델 검증 파일 저장</b>을 누르세요. 저장한 모델 검증 파일을 아래에서 가져오면 PC 등록으로 이어집니다.</p>
              </>}
              <div className="setup-actions"><button className="primary" onClick={onDownload} disabled={busy}><Download size={16} /> PC 설정 도우미 받기</button><button className="secondary" onClick={onModel} disabled={busy}><FileCheck2 size={16} /> 모델 확인 파일 가져오기</button></div>
            </> : state.step === 1 ? <>
              <h3>모델 준비가 끝났어요. 연결할 PC를 등록하세요.</h3>
              <p>PC 이름과 사용할 모델을 선택하세요. 등록 후 <b>연결 설정 저장</b>을 누르면 Relay 주소, 이 PC의 이름과 등록 정보, 비밀 참여 키가 담긴 파일을 저장하고 도우미가 자동으로 찾습니다.</p>
              <div className="setup-actions">
                <button className="primary" onClick={onNode} disabled={busy}>PC 등록하기 <ArrowRight size={16} /></button>
                {compact && <button className="secondary" onClick={onModel} disabled={busy}>다른 모델 확인 파일 가져오기</button>}
              </div>
            </> : state.step === 2 ? <>
              <h3><RefreshCw size={17} className="spin" /> PC의 연결을 기다리고 있어요.</h3>
              <p>PC 설정 도우미가 다운로드 폴더의 연결 파일을 자동으로 찾습니다. 이미 실행 중이어도 새 파일을 확인하며, 여러 개라면 서비스 주소와 PC 이름을 보고 선택하세요. <b>검사하고 참여 시작</b>을 누르면 이 PC가 Relay에서 작업을 받습니다.</p>
              <p>다른 폴더에 저장했다면 <b>연결 폴더 선택</b> 또는 <b>연결 파일 불러오기</b>를 사용하세요. 이전에 저장하거나 선택한 연결은 새 파일로 자동 교체되지 않습니다.</p>
              <div className="setup-actions"><button className="secondary" onClick={onNodes}>PC 상태 확인</button><button className="text-action" onClick={onDownload}>설정 도우미 다시 받기</button></div>
              <details><summary>연결이 안 되나요?</summary><p>도우미에서 선택한 파일과 모델이 같은지 확인하세요. 일시 정지한 PC는 GPU 노드에서 제공을 재개하세요. 다른 PC라면 서버의 HTTPS 주소가 필요합니다. 연결 설정을 잃어버렸다면 기존 노드의 키를 폐기한 뒤 PC를 다시 등록하세요.</p></details>
            </> : <>
              <h3><Check size={20} /> PC가 연결되었어요.</h3>
              <p>문서를 올리고 작업을 시작하세요. 배정, 추론, 결과 확인은 자동으로 진행됩니다.</p>
              <button className="primary" onClick={onCreate} disabled={busy}>첫 작업 만들기 <ArrowRight size={16} /></button>
            </>}
          </div>
          <details className="setup-requirements"><summary>처음 한 번 필요한 준비</summary><p>참여 PC에 Python 3.10 이상과 Tkinter, 승인된 llama-server 실행파일, GGUF 모델, chat template 파일이 필요합니다. 도우미는 파일 검사와 실행을 자동화합니다. 프로그램과 모델의 설치, 다른 PC에서 접속할 HTTPS 서버 준비는 운영자가 진행해야 합니다.</p><button className="text-action" onClick={onModel} disabled={busy}>다른 모델 등록</button></details>
        </section>
      )}
      {!compact && <div className="setup-automation"><Check size={18} /><p><b>반복 작업은 자동으로</b><span>저장된 모델 탐색 · 파일 해시 계산 · 작업 배정 · 결과 수집</span></p></div>}
    </div>
  );
}
