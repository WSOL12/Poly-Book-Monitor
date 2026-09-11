import TokenDetail from "@/components/TokenDetail";

export default async function TokenRoute({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  return <TokenDetail tokenId={tokenId} />;
}
