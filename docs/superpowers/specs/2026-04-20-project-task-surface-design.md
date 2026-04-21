# Project Task Surface Design

## Goal

Make project-linked tasks behave like normal tasks with project context instead of creating a second task system.

When a task is created from a project:

- it must appear in the project's `Tasks` tab
- it must also appear in the assignee's normal `Tasks` page
- director/admin must be able to create and reassign it from the project surface
- reps must be able to see project tasks and work the tasks assigned to them

## Current Problem

The app allows task creation from a project context, but there is no durable project-level task surface where those tasks live. That creates a broken mental model:

- users can create a task "for a project"
- but there is no clear project tab to find or manage those tasks later
- the relationship between project context and personal task assignment is not visible

## Product Decision

Use one shared task record with an optional `projectId`.

Do not create a separate project-task model and do not mirror tasks into a second table.

Each task should be visible through multiple filtered surfaces:

- `Project Tasks` tab: filter by `projectId`
- `My Tasks` page: filter by `assignedTo`

This keeps project context and personal ownership aligned without duplication.

## User Experience

### Project Detail

Add a project detail route with tabs. One tab must be `Tasks`.

The `Tasks` tab should show:

- all tasks linked to that project
- title
- status
- due date
- assignee
- priority if already supported by the task model
- creation/update timestamps if already supported by the existing task list pattern

Actions on the project `Tasks` tab:

- `director` and `admin`
  - create task
  - edit task
  - reassign task
  - complete/reopen task
- `rep`
  - view all project tasks
  - edit or complete tasks assigned to themselves
  - cannot reassign tasks owned by others

### Tasks Page

The normal `Tasks` page remains the assignee-centered queue.

Project-linked tasks should appear there automatically if the current user is the assignee.

They should display enough project context to make the source obvious, such as:

- project name
- linked company/property if already available in the task card pattern

### Task Creation

When creating a task from a project:

- `projectId` is attached automatically
- the assignee is required
- the created task becomes visible immediately in both places:
  - project `Tasks` tab
  - assignee `Tasks` page

No duplicate task should be created.

## Permissions

### Admin

- full access to project tasks
- can create, edit, complete, reopen, and reassign

### Director

- same project-task management powers as admin

### Rep

- can open the project `Tasks` tab
- can see all tasks for the project
- can update tasks assigned to themselves
- cannot change assignee unless separately authorized elsewhere

## Data Model

Reuse the existing task model.

Required addition:

- ensure tasks support a nullable `projectId` relationship to the project record being surfaced in `/projects`

If `projectId` already exists in the schema but is not fully wired through the API/UI, complete that wiring instead of creating new fields.

No new task table is introduced.

## Routing

Add a project detail route:

- `/projects/:id`

The existing `/projects` page remains the project list / entry point.

From that list, users should be able to open the project detail page and then navigate to `Tasks`.

## API Behavior

Project task support should use existing task APIs where possible.

Needed capabilities:

- fetch tasks by `projectId`
- create task with `projectId`
- update task assignment/status/details while preserving `projectId`

If the current task endpoints already support arbitrary record linkage, extend them minimally rather than creating a separate project-task API namespace.

## Audit and Consistency

Task reassignment or creation from a project should still behave like a normal task event.

That means:

- the same task id is used everywhere
- status changes stay in sync across project and personal task surfaces
- reassignment updates the assignee's task queue immediately

## Error Handling

### Project Tasks Tab

- empty state: clear message when the project has no tasks yet
- permission failure: standard forbidden handling
- missing project: standard not-found handling

### Task Mutations

- failed create or reassignment must leave the current list unchanged until confirmed
- mutation success should refresh both visible project-task data and any local task counts/state used by the page

## Testing

Verify:

1. project detail page renders a `Tasks` tab
2. creating a task from project detail persists the `projectId`
3. created project task appears in the project `Tasks` tab
4. the assignee also sees the same task in their `Tasks` page
5. director/admin can reassign from project detail
6. rep cannot reassign another user's task
7. completing a task from one surface is reflected in the other

## Out of Scope

- project-specific SLA timers
- separate project-task notifications system
- bulk reassignment
- project-only checklist model
- duplicating tasks into multiple records
