from sqlalchemy import CheckConstraint, ForeignKey, Index, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base

GRADES_ID = "grades.id"
USERS_ID = "users.id"
CONVERSATIONS_ID = "conversations.id"
ADMIN_GROUPS_ID = "admin_groups.id"
DORMITORY_ROUNDS_ID = "dormitory_selection_rounds.id"
ACTIVITIES_ID = "activities.id"
SET_NULL = "SET NULL"
NORMAL_STATUS_SQL = "'NORMAL'"
DRAFT_STATUS_SQL = "'DRAFT'"


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    login_identifier: Mapped[str] = mapped_column(Text, unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    password_salt: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text)
    account_type: Mapped[str] = mapped_column(Text, server_default=text("'USER'"))
    must_change_password: Mapped[int] = mapped_column(server_default=text("0"))
    name: Mapped[str] = mapped_column(Text)
    grade: Mapped[str] = mapped_column(Text)
    grade_id: Mapped[int | None] = mapped_column(ForeignKey(GRADES_ID))
    gender: Mapped[str] = mapped_column(Text, server_default=text("'UNSPECIFIED'"))
    major: Mapped[str] = mapped_column(Text, server_default=text("''"))
    email: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'PENDING_ACTIVATION'"))
    imported_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    last_login_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("role IN ('STUDENT','ADMIN')"),
        CheckConstraint("account_type IN ('USER','SUPER_ADMIN')"),
        CheckConstraint("must_change_password IN (0,1)"),
        CheckConstraint("gender IN ('MALE','FEMALE','UNSPECIFIED')"),
        CheckConstraint("status IN ('PENDING_ACTIVATION','ACTIVE','SUSPENDED','BANNED')"),
        Index("idx_users_gender_status", "gender", "status"),
    )


class RoommateCard(Base):
    __tablename__ = "roommate_cards"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), unique=True)
    avatar_url: Mapped[str] = mapped_column(Text, server_default=text("''"))
    school: Mapped[str] = mapped_column(Text, server_default=text("''"))
    campus: Mapped[str] = mapped_column(Text, server_default=text("''"))
    department: Mapped[str] = mapped_column(Text, server_default=text("''"))
    origin_province: Mapped[str] = mapped_column(Text, server_default=text("''"))
    origin_city: Mapped[str] = mapped_column(Text, server_default=text("''"))
    clothing_size: Mapped[str] = mapped_column(Text, server_default=text("''"))
    summer_temp_min: Mapped[int | None]
    summer_temp_max: Mapped[int | None]
    winter_temp_min: Mapped[int | None]
    winter_temp_max: Mapped[int | None]
    wake_up_time: Mapped[str] = mapped_column(Text, server_default=text("''"))
    sleep_time: Mapped[str] = mapped_column(Text, server_default=text("''"))
    nap_habit: Mapped[str] = mapped_column(Text, server_default=text("''"))
    personal_cleanliness: Mapped[str] = mapped_column(Text, server_default=text("''"))
    roommate_cleanliness: Mapped[str] = mapped_column(Text, server_default=text("''"))
    common_space_maintenance: Mapped[str] = mapped_column(Text, server_default=text("''"))
    unacceptable_hygiene: Mapped[str] = mapped_column(Text, server_default=text("''"))
    one_sentence_intro: Mapped[str] = mapped_column(Text, server_default=text("''"))
    personality_text: Mapped[str] = mapped_column(Text, server_default=text("''"))
    roommate_personality_text: Mapped[str] = mapped_column(Text, server_default=text("''"))
    interests_text: Mapped[str] = mapped_column(Text, server_default=text("''"))
    gaming_self: Mapped[str] = mapped_column(Text, server_default=text("''"))
    gaming_roommate: Mapped[str] = mapped_column(Text, server_default=text("''"))
    keyboard_noise_text: Mapped[str] = mapped_column(Text, server_default=text("''"))
    media_noise_text: Mapped[str] = mapped_column(Text, server_default=text("''"))
    sleep_preferences: Mapped[str] = mapped_column(Text, server_default=text("'[]'"))
    sleep_schedule_note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    cleanliness_level: Mapped[str] = mapped_column(Text, server_default=text("''"))
    cleanliness_note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    personality_tags: Mapped[str] = mapped_column(Text, server_default=text("'[]'"))
    personality_note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    roommate_personality_tags: Mapped[str] = mapped_column(Text, server_default=text("'[]'"))
    roommate_personality_note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    hobbies: Mapped[str] = mapped_column(Text, server_default=text("'[]'"))
    sports: Mapped[str] = mapped_column(Text, server_default=text("'[]'"))
    hobbies_note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    gaming_frequency: Mapped[str] = mapped_column(Text, server_default=text("''"))
    gaming_time_note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    keyboard_noise_tolerance: Mapped[str] = mapped_column(Text, server_default=text("''"))
    media_noise_tolerance: Mapped[str] = mapped_column(Text, server_default=text("''"))
    self_acknowledged_shortcoming: Mapped[str] = mapped_column(Text, server_default=text("''"))
    additional_note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    status: Mapped[str] = mapped_column(Text, server_default=text(DRAFT_STATUS_SQL))
    hidden_reason: Mapped[str | None] = mapped_column(Text)
    published_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("status IN ('DRAFT','PUBLISHED','HIDDEN')"),
        Index("idx_roommate_cards_status_updated", "status", "updated_at", "id"),
    )


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[int] = mapped_column(primary_key=True)
    student_a_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    student_b_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    last_message_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("student_a_id", "student_b_id"),
        CheckConstraint("student_a_id < student_b_id"),
        Index("idx_conversations_student_a_activity", "student_a_id", "last_message_at", "id"),
        Index("idx_conversations_student_b_activity", "student_b_id", "last_message_at", "id"),
    )


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey(CONVERSATIONS_ID, ondelete="CASCADE"))
    sender_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    message_type: Mapped[str] = mapped_column(Text, server_default=text("'TEXT'"))
    application_id: Mapped[int | None]
    __table_args__ = (Index("idx_messages_conversation", "conversation_id", "id"),)


class ConversationRead(Base):
    __tablename__ = "conversation_reads"
    conversation_id: Mapped[int] = mapped_column(ForeignKey(CONVERSATIONS_ID, ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    last_read_message_id: Mapped[int | None]
    updated_at: Mapped[str] = mapped_column(Text)


class Block(Base):
    __tablename__ = "blocks"
    blocker_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    blocked_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_blocks_blocked_blocker", "blocked_id", "blocker_id"),)


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    reporter_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    target_type: Mapped[str] = mapped_column(Text)
    target_id: Mapped[int]
    reason: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"))
    snapshot: Mapped[str] = mapped_column(Text, server_default=text("'{}'"))
    status: Mapped[str] = mapped_column(Text, server_default=text("'PENDING'"))
    handled_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    resolution: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    handled_at: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("target_type IN ('ROOMMATE_CARD','MESSAGE','TREEHOLE_POST','TREEHOLE_COMMENT')"),
        CheckConstraint("status IN ('PENDING','RESOLVED','REJECTED')"),
        Index("idx_reports_reporter_created", "reporter_id", "created_at"),
        Index("idx_reports_target", "target_type", "target_id"),
        Index("idx_reports_status_created", "status", "created_at"),
        Index(
            "idx_pending_reporter_target",
            "reporter_id",
            "target_type",
            "target_id",
            unique=True,
            sqlite_where=text("status = 'PENDING'"),
        ),
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    admin_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    admin_name_snapshot: Mapped[str] = mapped_column(Text, server_default=text("''"))
    action: Mapped[str] = mapped_column(Text)
    target_type: Mapped[str] = mapped_column(Text)
    target_id: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text, server_default=text("''"))
    metadata_json: Mapped[str] = mapped_column("metadata", Text, server_default=text("'{}'"))
    ip_address: Mapped[str] = mapped_column(Text, server_default=text("''"))
    user_agent: Mapped[str] = mapped_column(Text, server_default=text("''"))
    request_id: Mapped[str] = mapped_column(Text, server_default=text("''"))
    permission_code: Mapped[str] = mapped_column(Text, server_default=text("''"))
    grant_group_id: Mapped[int | None] = mapped_column(ForeignKey(ADMIN_GROUPS_ID))
    scope_type: Mapped[str] = mapped_column(Text, server_default=text("''"))
    scope_value: Mapped[str] = mapped_column(Text, server_default=text("''"))
    result: Mapped[str] = mapped_column(Text, server_default=text("'SUCCESS'"))
    before_snapshot: Mapped[str] = mapped_column(Text, server_default=text("'{}'"))
    after_snapshot: Mapped[str] = mapped_column(Text, server_default=text("'{}'"))
    created_at: Mapped[str] = mapped_column(Text)


class LoginSession(Base):
    __tablename__ = "sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    access_token_hash: Mapped[str] = mapped_column(Text, unique=True)
    access_expires_at: Mapped[str] = mapped_column(Text)
    csrf_token_hash: Mapped[str] = mapped_column(Text)
    refresh_expires_at: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    refreshed_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        Index("idx_sessions_user", "user_id"),
        Index("idx_sessions_refresh_expiry", "refresh_expires_at"),
    )


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    token_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    expires_at: Mapped[str] = mapped_column(Text)
    consumed_at: Mapped[str | None] = mapped_column(Text)
    replaced_by_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_refresh_tokens_session", "session_id"),)


class DormitorySelectionRound(Base):
    __tablename__ = "dormitory_selection_rounds"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"))
    status: Mapped[str] = mapped_column(Text, server_default=text(DRAFT_STATUS_SQL))
    starts_at: Mapped[str | None] = mapped_column(Text)
    ends_at: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    opened_at: Mapped[str | None] = mapped_column(Text)
    closed_at: Mapped[str | None] = mapped_column(Text)
    archived_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("status IN ('DRAFT','OPEN','CLOSED','ARCHIVED')"),
        Index("idx_single_open_dormitory_round", "status", unique=True, sqlite_where=text("status = 'OPEN'")),
    )


class DormitoryRoundParticipant(Base):
    __tablename__ = "dormitory_round_participants"
    round_id: Mapped[int] = mapped_column(ForeignKey(DORMITORY_ROUNDS_ID, ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    added_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_dormitory_round_participants_user", "user_id", "round_id"),)


class StudentSelectionGroup(Base):
    __tablename__ = "student_selection_groups"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"))
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("created_by", "name", name="uq_student_selection_groups_owner_name"),)


class StudentSelectionGroupMember(Base):
    __tablename__ = "student_selection_group_members"
    group_id: Mapped[int] = mapped_column(
        ForeignKey("student_selection_groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_student_selection_group_members_user", "user_id", "group_id"),)


class Activity(Base):
    __tablename__ = "activities"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    description_markdown: Mapped[str] = mapped_column(Text, server_default=text("''"))
    description_html: Mapped[str] = mapped_column(Text, server_default=text("''"))
    description_summary: Mapped[str] = mapped_column(Text, server_default=text("''"))
    start_at: Mapped[str] = mapped_column(Text)
    end_at: Mapped[str] = mapped_column(Text)
    is_all_day: Mapped[int] = mapped_column(server_default=text("0"))
    location: Mapped[str] = mapped_column(Text)
    organizer_type: Mapped[str] = mapped_column(Text)
    organizer_user_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    organizer_group_id: Mapped[int | None] = mapped_column(ForeignKey(ADMIN_GROUPS_ID, ondelete=SET_NULL))
    organizer_name_snapshot: Mapped[str] = mapped_column(Text)
    capacity: Mapped[int]
    importance: Mapped[int]
    status: Mapped[str] = mapped_column(Text, server_default=text(DRAFT_STATUS_SQL))
    version: Mapped[int] = mapped_column(server_default=text("1"))
    cancel_reason: Mapped[str] = mapped_column(Text, server_default=text("''"))
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    published_at: Mapped[str | None] = mapped_column(Text)
    cancelled_at: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("end_at > start_at"),
        CheckConstraint("is_all_day IN (0,1)"),
        CheckConstraint("organizer_type IN ('USER','ADMIN_GROUP')"),
        CheckConstraint(
            "(organizer_type='USER' AND organizer_group_id IS NULL) OR "
            "(organizer_type='ADMIN_GROUP' AND organizer_user_id IS NULL)"
        ),
        CheckConstraint("capacity BETWEEN 1 AND 500"),
        CheckConstraint("importance BETWEEN 1 AND 5"),
        CheckConstraint("status IN ('DRAFT','PUBLISHED','CANCELLED')"),
        CheckConstraint("version > 0"),
        Index("idx_activities_status_time", "status", "start_at", "end_at"),
        Index("idx_activities_organizer_user", "organizer_user_id", "status"),
        Index("idx_activities_organizer_group", "organizer_group_id", "status"),
    )


class ActivityTargetGrade(Base):
    __tablename__ = "activity_target_grades"
    activity_id: Mapped[int] = mapped_column(ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"), primary_key=True)
    grade_id: Mapped[int] = mapped_column(ForeignKey(GRADES_ID), primary_key=True)


class ActivityScopeGrade(Base):
    __tablename__ = "activity_scope_grades"
    activity_id: Mapped[int] = mapped_column(ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"), primary_key=True)
    grade_id: Mapped[int] = mapped_column(ForeignKey(GRADES_ID), primary_key=True)


class ActivityTargetGroup(Base):
    __tablename__ = "activity_target_groups"
    id: Mapped[int] = mapped_column(primary_key=True)
    activity_id: Mapped[int] = mapped_column(ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"))
    source_group_id: Mapped[int | None] = mapped_column(ForeignKey("student_selection_groups.id", ondelete=SET_NULL))
    group_name_snapshot: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("activity_id", "source_group_id"),
        Index("idx_activity_target_groups_activity", "activity_id", "id"),
    )


class ActivityTargetMember(Base):
    __tablename__ = "activity_target_members"
    id: Mapped[int] = mapped_column(primary_key=True)
    activity_id: Mapped[int] = mapped_column(ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    participant_name_snapshot: Mapped[str] = mapped_column(Text)
    grade_snapshot: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("activity_id", "user_id"),
        Index("idx_activity_target_members_user", "user_id", "activity_id"),
    )


class ActivityRegistration(Base):
    __tablename__ = "activity_registrations"
    id: Mapped[int] = mapped_column(primary_key=True)
    activity_id: Mapped[int] = mapped_column(ForeignKey(ACTIVITIES_ID, ondelete="CASCADE"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    participant_name_snapshot: Mapped[str] = mapped_column(Text)
    participant_grade_snapshot: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'REGISTERED'"))
    registered_at: Mapped[str] = mapped_column(Text)
    cancelled_at: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("activity_id", "user_id"),
        CheckConstraint("status IN ('REGISTERED','CANCELLED')"),
        Index("idx_activity_registrations_activity_status", "activity_id", "status", "id"),
        Index("idx_activity_registrations_user_status", "user_id", "status", "activity_id"),
    )


class Dormitory(Base):
    __tablename__ = "dormitories"
    id: Mapped[int] = mapped_column(primary_key=True)
    selection_round_id: Mapped[int] = mapped_column(ForeignKey(DORMITORY_ROUNDS_ID))
    dormitory_code: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    building: Mapped[str] = mapped_column(Text, server_default=text("''"))
    room_number: Mapped[str] = mapped_column(Text, server_default=text("''"))
    capacity: Mapped[int] = mapped_column(server_default=text("4"))
    initiator_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    management_grade_id: Mapped[int | None] = mapped_column(ForeignKey(GRADES_ID))
    gender: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'OPEN'"))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("capacity = 4"),
        CheckConstraint("gender IN ('MALE','FEMALE')"),
        CheckConstraint("status IN ('OPEN','FULL','CLOSED')"),
        Index(
            "idx_dormitories_round_gender_status_created",
            "selection_round_id",
            "gender",
            "status",
            "created_at",
            "id",
        ),
    )


class DormitoryMember(Base):
    __tablename__ = "dormitory_members"
    selection_round_id: Mapped[int] = mapped_column(ForeignKey(DORMITORY_ROUNDS_ID))
    dormitory_id: Mapped[int] = mapped_column(ForeignKey("dormitories.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    role: Mapped[str] = mapped_column(Text)
    joined_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("role IN ('INITIATOR','MEMBER')"),
        Index("idx_dormitory_member_round_user", "selection_round_id", "user_id", unique=True),
    )


class DormitoryApplication(Base):
    __tablename__ = "dormitory_applications"
    id: Mapped[int] = mapped_column(primary_key=True)
    selection_round_id: Mapped[int] = mapped_column(ForeignKey(DORMITORY_ROUNDS_ID))
    dormitory_id: Mapped[int] = mapped_column(ForeignKey("dormitories.id", ondelete="CASCADE"))
    applicant_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    conversation_id: Mapped[int] = mapped_column(ForeignKey(CONVERSATIONS_ID, ondelete="CASCADE"))
    message_id: Mapped[int | None] = mapped_column(ForeignKey("messages.id", ondelete=SET_NULL))
    note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    status: Mapped[str] = mapped_column(Text, server_default=text("'PENDING'"))
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    reviewed_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("status IN ('PENDING','APPROVED','REJECTED','CANCELLED')"),
        Index(
            "idx_pending_dormitory_application",
            "dormitory_id",
            "applicant_id",
            unique=True,
            sqlite_where=text("status = 'PENDING'"),
        ),
        Index(
            "idx_dormitory_applications_applicant_round_created",
            "applicant_id",
            "selection_round_id",
            "created_at",
        ),
    )


class DormitoryResultSnapshot(Base):
    __tablename__ = "dormitory_result_snapshots"
    id: Mapped[int] = mapped_column(primary_key=True)
    selection_round_id: Mapped[int] = mapped_column(ForeignKey(DORMITORY_ROUNDS_ID, ondelete="CASCADE"))
    source_dormitory_id: Mapped[int | None]
    dormitory_code: Mapped[str] = mapped_column(Text)
    dormitory_name: Mapped[str] = mapped_column(Text)
    building: Mapped[str] = mapped_column(Text, server_default=text("''"))
    room_number: Mapped[str] = mapped_column(Text, server_default=text("''"))
    capacity: Mapped[int]
    dormitory_status: Mapped[str] = mapped_column(Text)
    management_grade_id: Mapped[int | None] = mapped_column(ForeignKey(GRADES_ID))
    gender: Mapped[str] = mapped_column(Text)
    initiator_user_id: Mapped[int | None]
    initiator_name_snapshot: Mapped[str] = mapped_column(Text)
    generated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("selection_round_id", "source_dormitory_id"),)


class DormitoryResultMember(Base):
    __tablename__ = "dormitory_result_members"
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("dormitory_result_snapshots.id", ondelete="CASCADE"), primary_key=True
    )
    source_user_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    login_identifier_snapshot: Mapped[str] = mapped_column(Text, primary_key=True)
    name_snapshot: Mapped[str] = mapped_column(Text)
    grade_snapshot: Mapped[str] = mapped_column(Text)
    gender_snapshot: Mapped[str] = mapped_column(Text)
    major_snapshot: Mapped[str] = mapped_column(Text)
    member_role: Mapped[str] = mapped_column(Text)
    joined_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_dormitory_result_members_source", "source_user_id", "snapshot_id"),)


class OfficialDormitory(Base):
    __tablename__ = "official_dormitories"
    id: Mapped[int] = mapped_column(primary_key=True)
    dormitory_code: Mapped[str] = mapped_column(Text, unique=True)
    nickname: Mapped[str] = mapped_column(Text, server_default=text("''"))
    nickname_status: Mapped[str] = mapped_column(Text, server_default=text(NORMAL_STATUS_SQL))
    description_markdown: Mapped[str] = mapped_column(Text, server_default=text("''"))
    description_status: Mapped[str] = mapped_column(Text, server_default=text(NORMAL_STATUS_SQL))
    rules_markdown: Mapped[str] = mapped_column(Text, server_default=text("''"))
    rules_status: Mapped[str] = mapped_column(Text, server_default=text(NORMAL_STATUS_SQL))
    management_grade_id: Mapped[int] = mapped_column(ForeignKey(GRADES_ID))
    version: Mapped[int] = mapped_column(server_default=text("1"))
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint(f"nickname_status IN ({NORMAL_STATUS_SQL},'HIDDEN')"),
        CheckConstraint(f"description_status IN ({NORMAL_STATUS_SQL},'HIDDEN')"),
        CheckConstraint(f"rules_status IN ({NORMAL_STATUS_SQL},'HIDDEN')"),
        CheckConstraint("version > 0"),
        Index("idx_official_dormitories_updated", "updated_at", "id"),
        Index("idx_official_dormitories_grade", "management_grade_id", "id"),
    )


class OfficialDormitoryMember(Base):
    __tablename__ = "official_dormitory_members"
    id: Mapped[int] = mapped_column(primary_key=True)
    official_dormitory_id: Mapped[int] = mapped_column(ForeignKey("official_dormitories.id", ondelete="CASCADE"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    role: Mapped[str] = mapped_column(Text)
    position: Mapped[int]
    imported_login_identifier: Mapped[str] = mapped_column(Text)
    name_snapshot: Mapped[str] = mapped_column(Text)
    grade_snapshot: Mapped[str] = mapped_column(Text)
    major_snapshot: Mapped[str] = mapped_column(Text, server_default=text("''"))
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("official_dormitory_id", "position"),
        UniqueConstraint("official_dormitory_id", "user_id"),
        CheckConstraint("role IN ('LEADER','MEMBER')"),
        CheckConstraint("position BETWEEN 1 AND 4"),
        Index("idx_official_dormitory_members_user", "user_id", "official_dormitory_id"),
        Index(
            "idx_official_dormitory_single_leader",
            "official_dormitory_id",
            unique=True,
            sqlite_where=text("role = 'LEADER'"),
        ),
    )


class OfficialDormitoryRevision(Base):
    __tablename__ = "official_dormitory_revisions"
    id: Mapped[int] = mapped_column(primary_key=True)
    official_dormitory_id: Mapped[int] = mapped_column(ForeignKey("official_dormitories.id", ondelete="CASCADE"))
    field_name: Mapped[str] = mapped_column(Text)
    previous_value: Mapped[str] = mapped_column(Text)
    new_value: Mapped[str] = mapped_column(Text)
    from_version: Mapped[int]
    to_version: Mapped[int]
    edited_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    editor_name_snapshot: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("field_name IN ('NICKNAME','DESCRIPTION','RULES')"),
        CheckConstraint("to_version > from_version"),
        Index("idx_official_dormitory_revisions_dormitory", "official_dormitory_id", "id"),
    )


class Grade(Base):
    __tablename__ = "grades"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'ACTIVE'"))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (CheckConstraint("status IN ('ACTIVE','DISABLED')"),)


class TreeholeAuthorGrade(Base):
    __tablename__ = "treehole_author_grades"
    grade_id: Mapped[int] = mapped_column(ForeignKey(GRADES_ID, ondelete="CASCADE"), primary_key=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    created_at: Mapped[str] = mapped_column(Text)


class TreeholePost(Base):
    __tablename__ = "treehole_posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    management_grade_id: Mapped[int] = mapped_column(ForeignKey(GRADES_ID))
    title: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(Text, server_default=text("'PRIVATE'"))
    moderation_status: Mapped[str] = mapped_column(Text, server_default=text(NORMAL_STATUS_SQL))
    moderation_reason: Mapped[str] = mapped_column(Text, server_default=text("''"))
    moderated_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    moderated_at: Mapped[str | None] = mapped_column(Text)
    reviewed_at: Mapped[str | None] = mapped_column(Text)
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    published_at: Mapped[str | None] = mapped_column(Text)
    withdrawn_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("visibility IN ('PRIVATE','PUBLIC','WITHDRAWN')"),
        CheckConstraint(f"moderation_status IN ({NORMAL_STATUS_SQL},'HIDDEN','DELETED')"),
        Index(
            "idx_treehole_posts_public",
            "visibility",
            "moderation_status",
            "published_at",
            "id",
        ),
        Index("idx_treehole_posts_author_updated", "author_id", "updated_at", "id"),
        Index(
            "idx_treehole_posts_management",
            "management_grade_id",
            "visibility",
            "moderation_status",
            "created_at",
            "id",
        ),
    )


class TreeholeComment(Base):
    __tablename__ = "treehole_comments"
    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("treehole_posts.id", ondelete="CASCADE"))
    participant_id: Mapped[int] = mapped_column(ForeignKey("treehole_participants.id", ondelete="CASCADE"))
    parent_comment_id: Mapped[int | None] = mapped_column(ForeignKey("treehole_comments.id", ondelete=SET_NULL))
    reply_to_participant_id: Mapped[int | None] = mapped_column(
        ForeignKey("treehole_participants.id", ondelete=SET_NULL)
    )
    content: Mapped[str] = mapped_column(Text)
    is_official: Mapped[int] = mapped_column(server_default=text("0"))
    moderation_status: Mapped[str] = mapped_column(Text, server_default=text(NORMAL_STATUS_SQL))
    moderation_reason: Mapped[str] = mapped_column(Text, server_default=text("''"))
    moderated_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    moderated_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    deleted_at: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("is_official IN (0,1)"),
        CheckConstraint(f"moderation_status IN ({NORMAL_STATUS_SQL},'HIDDEN','DELETED')"),
        Index("idx_treehole_comments_post_created", "post_id", "created_at", "id"),
    )


class TreeholeParticipant(Base):
    __tablename__ = "treehole_participants"
    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("treehole_posts.id", ondelete="CASCADE"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    alias_number: Mapped[int]
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        UniqueConstraint("post_id", "user_id"),
        UniqueConstraint("post_id", "alias_number"),
        CheckConstraint("alias_number > 0"),
    )


class AdminGroup(Base):
    __tablename__ = "admin_groups"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"))
    status: Mapped[str] = mapped_column(Text, server_default=text("'ACTIVE'"))
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (CheckConstraint("status IN ('ACTIVE','DISABLED')"),)


class AdminGroupMember(Base):
    __tablename__ = "admin_group_members"
    group_id: Mapped[int] = mapped_column(ForeignKey(ADMIN_GROUPS_ID, ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_admin_group_members_user", "user_id"),)


class AdminGroupPermission(Base):
    __tablename__ = "admin_group_permissions"
    group_id: Mapped[int] = mapped_column(ForeignKey(ADMIN_GROUPS_ID, ondelete="CASCADE"), primary_key=True)
    permission_code: Mapped[str] = mapped_column(Text, primary_key=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_admin_group_permissions_code", "permission_code"),)


class AdminGroupScope(Base):
    __tablename__ = "admin_group_scopes"
    group_id: Mapped[int] = mapped_column(ForeignKey(ADMIN_GROUPS_ID, ondelete="CASCADE"), primary_key=True)
    scope_type: Mapped[str] = mapped_column(Text, primary_key=True)
    scope_value: Mapped[str] = mapped_column(Text, primary_key=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_admin_group_scopes_value", "scope_type", "scope_value"),)
