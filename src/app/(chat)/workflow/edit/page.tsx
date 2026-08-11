"use client";

import {
  convertDBEdgeToUIEdge,
  convertDBNodeToUINode,
} from "lib/ai/workflow/shared.workflow";
import Workflow from "@/components/workflow/workflow";
import { useSession } from "@/lib/backend/session-context";
import { fetcher } from "lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { Suspense, useEffect } from "react";

// Was workflow/[id] -- flattened to /workflow/edit?id= (a bare ?id= on
// /workflow itself would collide with the workflow list page there), see
// (chat)/page.tsx's doc comment for why dynamic segments moved to query
// params. Was a Server Component reading workflowRepository directly; now
// a client-side GET /api/workflow/{id}/structure (CheckAccess-gated on the
// sidecar the same way -- see internal/api/workflow/structure.go).
// hasEditAccess is recomputed client-side from the response's own
// userId/visibility fields, mirroring CheckAccess(id, userId,
// destructive=false)'s rule (owner always; public also allows non-owner
// writes; private/readonly don't) since there's no second server round
// trip that would tell us that more cheaply.
function WorkflowPageContent() {
  const id = useSearchParams().get("id");
  const { data: session } = useSession();
  const router = useRouter();
  const { data: structure, error } = useSWR(
    id ? `/api/workflow/${id}/structure` : null,
    fetcher,
  );

  useEffect(() => {
    if (error) router.replace("/workflow");
  }, [error, router]);

  if (!session || !structure) return null;

  const hasEditAccess =
    structure.userId === session.user.id || structure.visibility === "public";
  const initialNodes = structure.nodes.map(convertDBNodeToUINode);
  const initialEdges = structure.edges.map(convertDBEdgeToUIEdge);

  return (
    <Workflow
      key={id}
      workflowId={id!}
      initialNodes={initialNodes}
      initialEdges={initialEdges}
      hasEditAccess={hasEditAccess}
    />
  );
}

export default function WorkflowPage() {
  return (
    <Suspense fallback={null}>
      <WorkflowPageContent />
    </Suspense>
  );
}
