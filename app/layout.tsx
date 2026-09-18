import type { Metadata } from "next";import "./globals.css";
export const metadata:Metadata={title:"Relay · 협력형 GPU 실행 풀",description:"공개 문서 배치 작업을 함께 실행하고, 결과와 기여를 안전하게 기록합니다.",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ko"><body>{children}</body></html>}
