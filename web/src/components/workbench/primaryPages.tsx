import type { ComponentType } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { queryClient } from "@/api/client";
import { ErrorNotice, Loading } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { pluginsQuery } from "@/features/plugins/pluginsQuery";
import { skillsQuery } from "@/features/skills/skillsQuery";
import { prefetchTaskNotes } from "@/features/tasks/noteQueries";
import { automationsQuery } from "@/features/automations/automationsQuery";
import type { PrimaryPage } from "./PrimaryNavigation";

type DeferredPage = Exclude<PrimaryPage, "agents" | "settings">;

function preloadablePage<Props extends object>(
  page: DeferredPage,
  load: () => Promise<{ default: ComponentType<Props> }>,
  prefetchData: () => Promise<void>,
) {
  // A loaded bundle stays available for the lifetime of this window.
  const bundle = queryOptions({
    queryKey: ["primary-page", page],
    queryFn: async () => (await load()).default,
    staleTime: "static",
    gcTime: Infinity,
    retry: false,
  });

  function Page(props: Props & { visible?: boolean }) {
    const module = useQuery({ ...bundle, enabled: props.visible !== false });
    const Content = module.data;
    if (Content) return <Content {...props} />;
    if (props.visible === false) return null;
    return module.isError ? (
      <section className="workspace-frame items-start">
        <ErrorNotice error={module.error} retry={() => void module.refetch()} />
      </section>
    ) : (
      <PrimaryPageLoading page={page} />
    );
  }

  return {
    Page,
    prefetch() {
      void queryClient.prefetchQuery(bundle);
      void prefetchData().catch(() => {});
    },
  };
}

const pages = {
  automations: preloadablePage(
    "automations",
    () => import("@/features/automations/AutomationsPage"),
    () => queryClient.prefetchQuery(automationsQuery),
  ),
  plugins: preloadablePage(
    "plugins",
    () => import("@/features/plugins/PluginsPage"),
    () => queryClient.prefetchQuery(pluginsQuery),
  ),
  skills: preloadablePage(
    "skills",
    () => import("@/features/skills/SkillsPage"),
    () => queryClient.prefetchQuery(skillsQuery),
  ),
  tasks: preloadablePage(
    "tasks",
    () => import("@/features/tasks/TasksPage"),
    prefetchTaskNotes,
  ),
};

export const {
  automations: { Page: AutomationsPage },
  plugins: { Page: PluginsPage },
  skills: { Page: SkillsPage },
  tasks: { Page: TasksPage },
} = pages;

export function prefetchPrimaryPage(page: PrimaryPage) {
  if (page !== "agents" && page !== "settings") pages[page].prefetch();
}

export function schedulePrimaryPagePrefetch() {
  const prefetch = () => {
    for (const page of Object.values(pages)) page.prefetch();
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(prefetch, { timeout: 1500 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(prefetch, 500);
  return () => window.clearTimeout(id);
}

function PrimaryPageLoading({ page }: { page: DeferredPage }) {
  const { t } = useTranslation();
  return (
    <section className="workspace-frame" aria-label={t(`nav.${page}`)}>
      <aside
        className="secondary-sidebar primary-loading-sidebar"
        aria-hidden="true"
      >
        <div className="secondary-sidebar-content">
          <div className="sidebar-heading">
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex flex-col gap-3 px-3 py-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="mt-1 h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      </aside>
      <Loading className="flex-1 p-8" />
    </section>
  );
}
