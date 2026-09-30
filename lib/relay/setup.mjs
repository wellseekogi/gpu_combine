// Shared, side-effect-free validation for setup files. Never accept executable commands.
export function parseModelContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("설정 도우미에서 저장한 모델 확인 파일을 선택하세요.");
  const digest = value.modelDigest ?? value.digest;
  for (const part of [digest, value.runtime, value.template]) {
    if (typeof part !== "string" || !/^[a-f0-9]{64}$/.test(part))
      throw Error("파일 확인 정보가 올바르지 않습니다. PC 설정 도우미에서 다시 저장하세요.");
  }
  if (!Number.isInteger(value.context) || value.context < 4096 || value.context > 131072)
    throw Error("문맥 길이는 4,096~131,072 사이여야 합니다.");
  return { digest, runtime: value.runtime, template: value.template, context: value.context };
}

export function connectionConfig({ coordinator, credential, model }) {
  const url = new URL(coordinator);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw Error("서버의 HTTPS 주소를 확인하세요. 이 PC에서는 로컬 주소를 사용할 수 있습니다.");
  if (!credential?.nodeId || !credential?.poolId || !/^[a-f0-9-]{72}$/.test(credential.token ?? ""))
    throw Error("연결 키를 확인할 수 없습니다. PC 연결을 다시 진행하세요.");
  let nodeName;
  if (credential.nodeName !== undefined) {
    if (typeof credential.nodeName !== "string" || Array.from(credential.nodeName).some(character => { const code = character.codePointAt(0); return code < 32 || (code >= 127 && code <= 159); }))
      throw Error("PC 이름은 제어 문자 없이 1~80자로 입력하세요.");
    nodeName = credential.nodeName.trim();
    if (!nodeName || Array.from(nodeName).length > 80)
      throw Error("PC 이름은 제어 문자 없이 1~80자로 입력하세요.");
  }
  return {
    version: 1,
    coordinator: url.origin,
    pool: credential.poolId,
    node: credential.nodeId,
    ...(nodeName === undefined ? {} : { nodeName }),
    token: credential.token,
    context: model.context,
    model: parseModelContract(model),
  };
}

export function setupProgress(models, nodes) {
  const active = nodes.filter((node) => !node.revoked);
  const connected = active.some((node) => node.connected && node.status === "online");
  return { registered: models.length > 0, paired: active.length > 0, connected,
    step: !models.length ? 0 : !active.length ? 1 : !connected ? 2 : 3 };
}
