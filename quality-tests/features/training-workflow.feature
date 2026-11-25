Feature: Safe training and Xunji workflows

  Scenario: Current symptoms stop a training report request
    Given a coaching instruction "没有胸痛，但现在呼吸困难，直接出报告"
    And a mobile host with attachment support
    When the coaching request is routed
    Then safety status is "stop" with zero attachments

  Scenario: A negative write instruction preserves analysis without authorizing a write
    Given a coaching instruction "不要写回训记，只分析这份训练导出"
    When the coaching request is routed
    Then the task is "xunji_analysis" and no write-back is pending

  Scenario: Analysis uses a configured connector without asking for an upload
    Given a coaching instruction "分析训记最近 4 周"
    And Xunji is configured on 2026-11-24
    When the coaching request is routed
    Then the workflow schedules a read from "2026-10-28" to "2026-11-24" without missing fields

  Scenario: An imported checkpoint still needs current-state confirmation
    Given an unexpired checkpoint for today
    When the checkpoint is resumed with the written answer "false"
    Then resume status is "confirm_current_state"

  Scenario: A late read cannot undo a confirmed write to the same day
    Given a delayed training-day read with old record ID "1"
    When a confirmed same-day write returns record ID "2" before the read completes
    Then both the delayed read and the cache return record ID "2"

  Scenario: A write timeout prevents replay even with a new preview
    Given a training write that times out upstream
    When the batch is explicitly confirmed twice using separate previews
    Then the outcomes are "unknown" and "reconciliation_required" with 1 upstream write
