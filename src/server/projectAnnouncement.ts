/**
 * Pure helper that decides whether to prepend an "(Active project: X)"
 * announcement to the user's task before sending it to the pi agent.
 *
 * Pi keeps the announcement in its conversation context, so we only inject
 * it on the *first* turn after focusedProject changes — re-announcing every
 * turn would bloat the prompt and confuse the model. Returns the (possibly
 * prefixed) task plus the announcedProject value the caller should write back
 * onto the session.
 */
export function applyProjectAnnouncement(
  task: string,
  focusedProject: string | undefined,
  announcedProject: string | undefined,
  focusedProjectDir?: string | undefined,
): { task: string; announcedProject: string | undefined } {
  if (!focusedProject || focusedProject === announcedProject) {
    return { task, announcedProject };
  }
  const root = focusedProjectDir ? ` Project root: ${focusedProjectDir}.` : '';
  return {
    task: `(Active project: ${focusedProject}.${root} Use this project for the user's request unless they specify a different one.)\n\n${task}`,
    announcedProject: focusedProject,
  };
}
