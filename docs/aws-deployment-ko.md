# AWS 서울 리전에 중앙 서버 배포

로컬 PC를 꺼도 웹 화면·작업 배정·계정·정산을 유지하는 구성입니다. GPU 추론은 참여자 PC에서 계속 실행합니다. 새 EC2에는 기존 계정·GPU 등록·잔액이 자동으로 복사되지 않습니다. 필요한 경우 아래 데이터 이전 절차를 따릅니다.

## 현재 배포 (2026-09-23)

- 서비스 주소: https://gpu-together.3.38.50.72.sslip.io
- EC2: `i-0d77eadaf3e553d2a`, 서울, 고정 IP `3.38.50.72`
- 서버 파일: `/opt/relay/active` → `/opt/relay/releases/20260923-144742-dd970379`; 운영 명령은 `/opt/relay/active/deploy/aws`에서 실행
- 현재 PC 도우미: `0.5.1`. 지속 GPU 대여와 모델 유지 기능을 포함합니다. 사이트에서 받는 ZIP에는 서비스 주소가 포함됩니다.
- 이전 릴리스: `/opt/relay/releases/20260923-143612-2a672a35`(0.5.0) 및 `/opt/relay/releases/20260923-pairing-7d83ce`(0.4.0) 보존. 새 대여 기록을 구버전이 처리할 수 없으므로 운영 재개 후에는 이미지 롤백만 실행하지 않습니다. 복구 시 데이터 호환성을 확인하고 필요하면 배포 전 백업을 사용합니다.
- 배포 전 DB 백업: `/opt/relay/backups/before-20260923-144742-dd970379.tar.gz` (비공개, 관리자 키 포함).
- GitHub 자동 업데이트: [provider-v0.5.1](https://github.com/wellseekogi/gpu_combine/releases/tag/provider-v0.5.1), 릴리스 CI 성공. 기존 `START-PROVIDER.cmd`를 다시 실행하면 최신 버전을 확인합니다.
- 검증: 실행 중 작업 0건 확인 후 접속을 잠시 중지하고 백업·교체했습니다. 컨테이너 healthy, 외부 HTTPS, 웹 JS/CSS와 빌드 일치, 도우미 ZIP 버전·모든 파일 해시를 확인했습니다. 실제 두 PC GPU 추론은 별도 확인이 필요합니다.
- 접속: 프로젝트의 `OPEN-AWS-RELAY.cmd`를 더블 클릭하면 로컬 서버를 시작하지 않고 AWS 화면을 엽니다.
- 관리자 키: 기존 개발 PC `.relay/admin-key.txt`를 그대로 사용합니다. 키 내용은 공개 문서에 기록하지 않습니다.
- 데이터: 기존 모델 1개·실제 GPU 등록 1개·완료 작업 기록을 이전했습니다. 원본과 이전 백업은 로컬 `.relay` 아래에 보존합니다.
- 관리 연결: 직접 SSH 대신 사용자 승인 후 EC2 전용 `AmazonSSMManagedInstanceCore` 역할을 연결했습니다. AWS 콘솔에서 해당 EC2 선택 → 연결 → Session Manager로 관리합니다.
- 로컬 `.relay/this-pc-connection.json`의 coordinator를 새 주소로 갱신했습니다. 이미 열린 PC 도우미는 연결 파일을 다시 불러와야 반영됩니다.

AWS에서 실제 운영할 때 아래 예시의 `~/relay/deploy/aws`는 `/opt/relay/active/deploy/aws`로 바꿉니다. Docker 명령은 Session Manager 셸에서 `sudo`로 실행합니다. 직접 SSH용 절차는 새 환경에서 SSH가 허용되는 경우의 대안입니다.

## 구성과 비용

| 항목 | 초기 테스트 설정 |
|---|---|
| 리전 | 서울 `ap-northeast-2` |
| EC2 | Ubuntu Server 24.04 LTS, x86_64, `t3.small` 2GB |
| CPU 크레딧 | Standard: 잔여 CPU 크레딧이 없으면 처리 속도 제한, Unlimited 추가 요금 없음 |
| 디스크 | 암호화 gp3 20GB, 기본 IOPS/처리량 |
| 고정 주소 | Elastic IP 한 개를 인스턴스에 연결 |
| 테스트 도메인 | `gpu-together.<Elastic IPv4>.sslip.io` |
| 프로세스 | Docker Compose: Relay + Caddy 자동 재시작 |
| 데이터 | Docker 볼륨 `relay_data`; 인증서 `relay_caddy_data` |
| 외부 포트 | 80/443, 관리용 SSH 22는 내 IP에서만 |

2026-09-19 확인 기준 서울 Linux t3.small $0.026/시간 × 730시간 = $18.98, 공인 IPv4 $0.005/시간 × 730시간 = $3.65입니다. gp3 20GB에 약 $2의 예산을 더하면 **월 약 $25**입니다. 디스크 금액은 예산 추정치이며 콘솔 견적을 우선합니다. 세금·추가 트래픽·스냅샷은 별도입니다. 크레딧 $100은 이 구성만 쓴다는 가정으로 약 4개월분입니다.

신규 Free plan은 가입 6개월 또는 크레딧 소진 중 먼저 오는 때 종료합니다. Free tier eligible은 무기한 무료라는 의미가 아닙니다. 콘솔에서 실제 계정 플랜·잔액·만료일을 확인합니다. 본 구성은 RDS, NAT Gateway, 로드밸런서, AWS GPU를 생성하지 않습니다.

가격·계정 조건: [서울 EC2 공식 가격 데이터](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/Asia%20Pacific%20%28Seoul%29/Linux/index.json), [IPv4 요금](https://aws.amazon.com/vpc/pricing/), [EBS 요금](https://aws.amazon.com/ebs/pricing/), [Free plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html).

## 1. 배포 ZIP 만들기

개발 PC의 프로젝트 폴더에서 실행합니다. Node.js 22.13 이상과 설치된 npm 의존성이 필요합니다.

```powershell
npm.cmd run package:server
```

결과는 `outputs/aws-deploy/relay-server.zip`입니다. 화면을 미리 빌드하므로 EC2에서 npm 설치나 화면 빌드가 필요 없습니다. ZIP은 서버 코드·화면·참여자 배포 파일·AWS 설정만 포함하며 `.relay`, `.env`, 모델, 계정 복구 파일, Git 기록, SSH 키를 제외합니다. 선택된 파일 경로의 symlink/junction도 거부합니다.

## 2. AWS 서버 만들기

[서울 EC2 콘솔](https://ap-northeast-2.console.aws.amazon.com/ec2/home?region=ap-northeast-2)에서 인스턴스를 생성합니다.

1. 이름 `gpu-together-relay`, 공식 Ubuntu Server 24.04 LTS x86_64 AMI, `t3.small`을 선택합니다. AMI 게시자는 Canonical이어야 합니다.
2. 로그인용 키 페어를 만들거나 기존 키를 선택합니다. 내려받은 `.pem`은 개발 PC에 보관합니다.
3. 기본 VPC의 퍼블릭 서브넷과 공인 IPv4를 사용합니다. 새 보안 그룹에서 TCP 22는 **내 IP**, TCP 80/443은 인터넷(`0.0.0.0/0`)에 허용합니다. 8788은 열지 않습니다.
4. 암호화 gp3 20GB를 설정합니다. 고급 설정에서 CPU 크레딧은 **Standard**, 메타데이터는 **IMDSv2 필수**로 설정합니다.
5. 시작 후 상태 검사 통과를 기다립니다. Elastic IP 한 개를 할당하고 이 인스턴스에 연결합니다. 미연결 상태에서도 IPv4 요금이 발생합니다.
6. Billing의 Free Tier/Credits에서 잔액·종료일을 확인합니다. 예산 알림을 설정한다면 수신 주소와 크레딧 포함 여부도 확인합니다. 예산 알림은 서버를 자동 정지하지 않습니다.

`aws login`을 지원하는 AWS CLI v2.32 이상이 있다면 장기 액세스 키 없이 콘솔 계정으로 인증할 수 있습니다. 자동 배포에 앞서 한 번 직접 로그인합니다.

```powershell
aws login --profile relay-deploy --region ap-northeast-2
```

자세한 인증 절차: [AWS CLI 콘솔 로그인](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html). 비밀번호·MFA·비밀 액세스 키는 채팅으로 전달하지 않습니다.

## 3. 업로드와 실행

아래 `YOUR_ELASTIC_IP`와 키 파일 경로를 실제 값으로 바꿉니다. 최초 SSH 연결의 호스트 키는 AWS에서 확인한 값과 대조합니다.

```powershell
scp -i C:\path\relay.pem C:\gpu_togeter\outputs\aws-deploy\relay-server.zip ubuntu@YOUR_ELASTIC_IP:relay-server.zip
ssh -i C:\path\relay.pem ubuntu@YOUR_ELASTIC_IP
```

접속한 Ubuntu 셸에서 실행합니다.

```bash
sudo apt-get update
sudo apt-get install -y unzip
mkdir -p ~/relay
unzip ~/relay-server.zip -d ~/relay
cd ~/relay
sudo bash deploy/aws/install-docker.sh

# 실제 Elastic IPv4 주소로 바꿉니다. 이 명령이 .env를 생성합니다.
sudo docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/deploy/aws:/config" -w /config node:22-bookworm-slim \
  node configure.mjs YOUR_ELASTIC_IP

cd deploy/aws
sudo docker compose config --quiet
sudo docker compose up -d --build --wait --wait-timeout 180
sudo docker compose ps
```

`configure.mjs`는 주소를 검사해 `gpu-together.<IP>.sslip.io`로 설정하며 기존 `.env`는 덮어쓰지 않습니다. 소유한 도메인이 있다면 IP 대신 `relay.example.com`을 전달하고 DNS A 레코드를 Elastic IP로 연결합니다. sslip.io는 공개 DNS 서비스이므로 별도 등록·도메인 구매가 필요 없습니다. 주소가 IP에 의존하므로 Elastic IP를 유지합니다. 공유 DNS의 가용성과 인증서 발급 제한은 서비스 제공자에 의존합니다. [sslip.io 설명](https://sslip.io/)

Caddy가 80/443을 통해 도메인을 확인하고 TLS 인증서를 자동 발급·갱신합니다. 초기에는 발급까지 잠시 기다려야 합니다. 브라우저에서 `https://gpu-together.<IP>.sslip.io`가 인증서 경고 없이 열리는지 확인합니다. 발급 실패 시 `sudo docker compose logs --tail 80 caddy`와 보안 그룹·DNS를 확인합니다. Compose의 `--wait` 성공만으로 외부 HTTPS까지 검증된 것은 아닙니다.

```bash
# 운영자 본인이 SSH 터미널에서만 확인합니다. 채팅/공개 로그에 붙이지 않습니다.
sudo docker compose exec -T relay cat /var/lib/relay/admin-key.txt
```

이 키로 웹의 관리자 로그인을 합니다. 새 GPU PC는 공개 HTTPS 사이트의 **내 GPU 제공**에서 연결 코드를 만들고 도우미의 **서버에 바로 연결**에 입력합니다. 기존 `127.0.0.1` 주소의 연결 파일은 원격 서버에 접속할 수 없으므로, 이미 등록한 PC는 공개 주소로 다시 연결해야 합니다.

## 운영 확인

- 로그인·개인 계정 생성·참여자 ZIP 다운로드·체험 작업을 확인합니다.
- 실제 참여자 PC 한 대를 연결하여 온라인 표시와 실제 GPU 작업을 확인합니다.
- `sudo docker compose restart relay` 후 기존 계정·GPU 등록·잔액이 유지되는지 확인합니다. 브라우저 관리자 세션은 메모리에 있어 재로그인이 필요합니다.
- EC2를 재부팅하면 Docker가 시작되고 컨테이너가 다시 실행됩니다. `docker compose stop`으로 수동 정지한 컨테이너는 `up -d`로 다시 켭니다.

실행 상태와 로그:

```bash
cd ~/relay/deploy/aws
sudo docker compose ps
sudo docker compose logs --tail 100 relay caddy
```

현재 단일 서버·SQLite 구성이므로 여러 Relay 인스턴스를 같은 데이터로 동시에 실행하지 않습니다. 이 Compose는 분산 LLM leader/RPC를 배포하지 않으며 `RELAY_INFERENCE_CONFIG`도 설정하지 않습니다. 분산 LLM은 별도 실행기·네트워크 설계와 검증이 필요합니다.

`RELAY_TRUST_PROXY=1`일 때 서버는 프록시가 덮어쓴 단일 `X-Real-IP`만 사용합니다. 누락·중복·잘못된 값은 400입니다. `X-Forwarded-For`는 클라이언트 IP 판정에 사용하지 않습니다. 로컬 자동 로그인도 비활성입니다. Relay의 8788 포트를 퍼블릭으로 연결하거나 다른 임의 컨테이너를 backend 네트워크에 붙이지 않습니다.

## 백업과 기존 데이터 이전

백업에는 관리자 키·개인 계정·GPU 인증 정보가 포함됩니다. 공개 ZIP이나 Git에 넣지 않습니다. 서버 정상 종료 후 전체 데이터 디렉터리를 복사해야 SQLite WAL까지 일관되게 보존됩니다.

현재 AWS 서버의 일관된 백업:

```bash
mkdir -p ~/relay-backups
sudo bash ~/relay/deploy/aws/backup.sh "$HOME/relay-backups/relay-$(date +%Y%m%d-%H%M%S).tar.gz"
```

백업 중에는 Relay를 잠시 멈추고 완료·실패 후 다시 시작합니다. 백업 성공 파일은 root 소유 600 권한입니다. 아직 자동 스케줄·외부 저장소 복제는 설정하지 않으므로 중요한 백업은 소유자의 안전한 별도 저장소에도 보관합니다.

개발 PC의 기존 데이터를 옮기려면 실행 중인 로컬 Relay를 정상 종료하고 `.relay` 전체를 비공개 전송합니다. 새 EC2의 `relay_data`가 비어 있는 첫 실행 전이 가장 간단합니다. 이미 AWS에서 생성한 계정·잔액과 자동 병합하지 않습니다. 원본과 목적지 양쪽을 먼저 백업하고, 검증된 자신의 백업만 복원합니다.

빈 볼륨에 자신의 백업을 복원하는 예시(기존 데이터가 있으면 오류로 중단):

```bash
cd ~/relay/deploy/aws
sudo docker compose stop -t 30 relay
sudo docker volume create relay_data
# /absolute/private-backup-dir/relay.tar.gz를 사전에 준비합니다.
sudo docker run --rm --user 0 --entrypoint sh \
  -v relay_data:/data -v /absolute/private-backup-dir:/backup:ro \
  node:22-bookworm-slim -c \
  'test -z "$(ls -A /data)" && tar -xzf /backup/relay.tar.gz -C /data && chown -R 1000:1000 /data'
sudo docker compose up -d --wait
```

복원 명령이 실패하면 원인을 해결하기 전 `up`을 실행하지 않습니다. 백업의 최상위에는 `relay.sqlite`, `admin-key.txt` 등이 있어야 하며 `.relay/` 폴더 자체를 한 단계 더 감싸지 않습니다. 이 예시는 관리자 본인이 만든 신뢰 가능한 백업 전용입니다.

## 업데이트와 종료

새 ZIP을 별도 릴리스 폴더에 풉니다. 이전 `.env`를 같은 `deploy/aws/.env` 위치에 복사하고 해당 폴더에서 `sudo docker compose up -d --build --wait`를 실행합니다. 고정된 볼륨 이름을 사용하므로 계정·DB·인증서가 유지됩니다. 이미지의 보안 업데이트를 포함하려면 `sudo docker compose build --pull relay`와 `sudo docker compose pull caddy` 후 실행합니다. 업데이트 전에 백업하고 이전 릴리스도 보관합니다.

일시 정지는 `sudo docker compose stop`입니다. EC2를 정지해도 EBS와 Elastic IP 요금은 남습니다. 실험 종료 시 백업을 확보한 후 EC2·불필요한 EBS/스냅샷·Elastic IP를 각각 정리해야 과금이 멈춥니다. `docker compose down -v`는 DB와 인증서 볼륨을 삭제하므로 일반 중지·업데이트에 사용하지 않습니다.

기술 참고: [Docker Ubuntu 설치](https://docs.docker.com/engine/install/ubuntu/), [Caddy 자동 HTTPS](https://caddyserver.com/docs/automatic-https), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
