import { redirect } from "next/navigation";

export default function Home() {
  // 첫 화면 = 글로벌 핵심지표(오너 지시 2026-10-04)
  redirect("/macro");
}
