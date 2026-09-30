import { ArrowRight, Check, Cpu, Layers3, MessageSquare, Server, Terminal } from "lucide-react";

type Props = { onRun: () => void; onProvide: () => void; onDistributed: () => void };

export default function ServiceHome({ onRun, onProvide, onDistributed }: Props) {
  return <div className="service-home">
    <section className="compute-hero" aria-labelledby="compute-title">
      <div className="compute-intro">
        <span className="compute-eyebrow"><span /> 함께 쓰는 GPU, 직접 실행하는 LLM</span>
        <h1 id="compute-title">다른 사람의 GPU에서<br /><em>LLM을 실행하세요.</em></h1>
        <p>다른 사람이 제공하는 GPU를 선택하고, 실행하고 싶은 LLM을 올리세요. 내 모델이 빌린 GPU에서 실행되고, 답변은 이곳으로 돌아옵니다.</p>
        <div className="compute-actions">
          <button className="primary" onClick={onRun}>GPU에서 LLM 실행 <ArrowRight size={17} /></button>
          <button className="secondary" onClick={onProvide}><Cpu size={17} /> 내 GPU 제공하기</button>
        </div>
        <div className="compute-caption"><Check size={15} /> 내 GGUF 모델 업로드 · 원격 적재 · 프롬프트 실행</div>
      </div>
      <div className="compute-diagram" aria-label="프롬프트를 참여자 GPU로 보내 LLM 답변을 받는 실행 구조">
        <div className="compute-diagram-top"><Layers3 size={19} /><span>REMOTE LLM COMPUTE</span></div>
        <div className="compute-request"><MessageSquare size={19} /><div><b>내 LLM + 프롬프트</b><small>실행자가 선택한 GGUF 모델</small></div><ArrowRight size={17} /></div>
        <div className="compute-link"><span />선택한 GPU로 모델 파일 전송<span /></div>
        <div className="compute-device"><div className="compute-device-icon"><Cpu size={38} strokeWidth={1.3} /></div><div><small>실제 실행 위치</small><h2>빌린 GPU</h2><p>내가 올린 LLM을 원격으로 적재하고 실행</p></div></div>
        <div className="compute-return"><Terminal size={17} /><span>생성된 답변을 내 작업 화면으로</span><Check size={17} /></div>
      </div>
    </section>

    <section className="compute-how" aria-labelledby="compute-how-title">
      <div className="compute-section-heading"><div><span className="compute-eyebrow">HOW IT WORKS</span><h2 id="compute-how-title">모델은 내가, GPU는 함께.</h2></div><span className="muted small">LLM 실행자와 GPU 제공자를 연결합니다.</span></div>
      <ol className="compute-steps">
        <li><span>01</span><div><h3>다른 사람의 GPU 선택</h3><p>제공 중인 GPU의 메모리와 연결 상태를 확인하고 실행할 GPU를 고릅니다.</p></div></li>
        <li><span>02</span><div><h3>내 LLM 업로드와 실행</h3><p>원하는 GGUF 모델과 프롬프트를 제출하면 빌린 GPU에 모델을 적재합니다.</p></div></li>
        <li><span>03</span><div><h3>결과 확인과 GPU 반환</h3><p>생성된 답변을 확인합니다. 요청이 끝나면 모델을 내리고 GPU를 반환합니다.</p></div></li>
      </ol>
    </section>

    <div className="compute-options">
      <section className="card compute-option"><Cpu size={23} /><h2>다른 사람에게 내 GPU 빌려주기</h2><p>PC 도우미를 연결하고 GPU 제공을 시작하세요. 실행자가 올린 모델을 내 GPU에서 처리하고 크레딧을 받습니다.</p><button className="text-action" onClick={onProvide}>GPU 연결 시작 <ArrowRight size={16} /></button></section>
      <section className="card compute-option"><Server size={23} /><h2>여러 GPU로 더 큰 모델 실행</h2><p>운영자가 구성한 분산 실행 그룹에서 하나의 모델을 여러 GPU에 나눠 실행하고, 대화와 API로 이용합니다.</p><button className="text-action" onClick={onDistributed}>분산 LLM 콘솔 <ArrowRight size={16} /></button></section>
    </div>
    <p className="compute-availability">현재 GGUF 단일 파일과 내장 채팅 템플릿을 지원합니다. GPU는 요청 단위로 사용하며, 모델 크기와 문맥 길이가 선택한 GPU에서 실행 가능한 범위여야 합니다.</p>
  </div>;
}
