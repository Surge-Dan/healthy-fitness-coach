Feature: Healthy Fitness Coach quality gates
  The Skill must keep training data private, truthful, and useful for action

  Scenario: Cached Xunji reads do not duplicate a same-day request
    Given a local Xunji cache with no entry for 2026-08-01
    When the same training day is requested twice concurrently
    Then the upstream request count is 1

  Scenario: Annual heatmap stays inside its SVG viewport
    Given training dates spanning 2026-01-01 to 2026-12-31
    When an annual training heatmap is rendered
    Then all 365 heatmap cells are inside the viewport

  Scenario: Write-back rejects mixed training dates
    Given write-back rows from two different dates
    When the write-back payload is validated
    Then validation fails before any network call

  Scenario: A single photo receives three structurally different recipes
    Given one local fitness photo with observed visual facts
    When the visual brief is compiled
    Then 3 recommendations use different composition grammars

  Scenario: A derived art layer cannot invent training facts
    Given a traceable fitness motif from the source photo
    When the image-model prompt is compiled
    Then text numbers logos and invented achievements are forbidden

  Scenario: Multiple photos remain present in the training storyboard
    Given 3 local fitness photos
    When a multi-photo storyboard is rendered
    Then all 3 originals are present in separate narrative panels
