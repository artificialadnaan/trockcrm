import { useTasks, useTaskCounts } from "@/hooks/use-tasks";
import { TaskSection } from "@/components/tasks/task-section";
import { TaskCreateDialog } from "@/components/tasks/task-create-dialog";

export function TaskListPage() {
  const { counts, refetch: refetchCounts } = useTaskCounts();

  const { tasks: overdueTasks, refetch: refetchOverdue } = useTasks({ section: "overdue" });
  const { tasks: todayTasks, refetch: refetchToday } = useTasks({ section: "today" });
  const { tasks: upcomingTasks, refetch: refetchUpcoming } = useTasks({ section: "upcoming" });
  const { tasks: completedTasks, refetch: refetchCompleted } = useTasks({
    section: "completed",
    limit: 20,
  });

  const refetchAll = () => {
    refetchCounts();
    refetchOverdue();
    refetchToday();
    refetchUpcoming();
    refetchCompleted();
  };

  const totalActive = counts.overdue + counts.today + counts.upcoming;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Tasks</h2>
          <p className="text-muted-foreground text-sm">
            {totalActive} active task{totalActive !== 1 ? "s" : ""}
            {counts.overdue > 0 && (
              <span className="text-red-600 font-medium ml-1">
                ({counts.overdue} overdue)
              </span>
            )}
          </p>
        </div>
        <TaskCreateDialog onCreated={refetchAll} />
      </div>

      {/* Task Sections */}
      <div className="space-y-3">
        <TaskSection
          title="Overdue"
          tasks={overdueTasks}
          count={counts.overdue}
          variant="danger"
          defaultOpen={true}
          onUpdate={refetchAll}
        />
        <TaskSection
          title="Today"
          tasks={todayTasks}
          count={counts.today}
          variant="warning"
          defaultOpen={true}
          onUpdate={refetchAll}
        />
        <TaskSection
          title="Upcoming"
          tasks={upcomingTasks}
          count={counts.upcoming}
          variant="default"
          defaultOpen={true}
          onUpdate={refetchAll}
        />
        <TaskSection
          title="Completed (Last 7 Days)"
          tasks={completedTasks}
          count={counts.completed}
          variant="muted"
          defaultOpen={false}
          onUpdate={refetchAll}
        />
      </div>
    </div>
  );
}
