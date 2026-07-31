from sqlalchemy import CheckConstraint, ForeignKey, Index, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base

GRADES_ID = "grades.id"
USERS_ID = "users.id"
CONVERSATIONS_ID = "conversations.id"
ADMIN_GROUPS_ID = "admin_groups.id"
DORMITORY_ROUNDS_ID = "dormitory_selection_rounds.id"
SET_NULL = "SET NULL"


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    login_identifier: Mapped[str] = mapped_column(Text, unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    password_salt: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text)
    account_type: Mapped[str] = mapped_column(Text, server_default=text("'USER'"))
    authorization_version: Mapped[int] = mapped_column(server_default=text("1"))
    must_change_password: Mapped[int] = mapped_column(server_default=text("0"))
    name: Mapped[str] = mapped_column(Text)
    grade: Mapped[str] = mapped_column(Text)
    grade_id: Mapped[int | None] = mapped_column(ForeignKey(GRADES_ID))
    gender: Mapped[str] = mapped_column(Text, server_default=text("'UNSPECIFIED'"))
    major: Mapped[str] = mapped_column(Text, server_default=text("''"))
    email: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'PENDING_ACTIVATION'"))
    imported_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    deactivated_at: Mapped[str | None] = mapped_column(Text)
    last_login_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("role IN ('STUDENT','ADMIN')"),
        CheckConstraint("account_type IN ('USER','SUPER_ADMIN')"),
        CheckConstraint("must_change_password IN (0,1)"),
        CheckConstraint("gender IN ('MALE','FEMALE','UNSPECIFIED')"),
        CheckConstraint("status IN ('PENDING_ACTIVATION','ACTIVE','SUSPENDED','BANNED','DEACTIVATED')"),
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
    status: Mapped[str] = mapped_column(Text, server_default=text("'DRAFT'"))
    hidden_reason: Mapped[str | None] = mapped_column(Text)
    published_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (CheckConstraint("status IN ('DRAFT','PUBLISHED','HIDDEN')"),)


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[int] = mapped_column(primary_key=True)
    student_a_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    student_b_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    last_message_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("student_a_id", "student_b_id"), CheckConstraint("student_a_id < student_b_id"))


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey(CONVERSATIONS_ID, ondelete="CASCADE"))
    sender_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    message_type: Mapped[str] = mapped_column(Text, server_default=text("'TEXT'"))
    application_id: Mapped[int | None]
    __table_args__ = (Index("idx_messages_conversation", "conversation_id", "created_at", "id"),)


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
        CheckConstraint("target_type IN ('ROOMMATE_CARD','MESSAGE')"),
        CheckConstraint("status IN ('PENDING','RESOLVED','REJECTED')"),
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
    token_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    csrf_token: Mapped[str] = mapped_column(Text)
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"))
    expires_at: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)


class SystemSetting(Base):
    __tablename__ = "system_settings"
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID))
    updated_at: Mapped[str] = mapped_column(Text)


class DormitorySelectionRound(Base):
    __tablename__ = "dormitory_selection_rounds"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"))
    status: Mapped[str] = mapped_column(Text, server_default=text("'DRAFT'"))
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
    name: Mapped[str] = mapped_column(Text, unique=True)
    description: Mapped[str] = mapped_column(Text, server_default=text("''"))
    created_by: Mapped[int | None] = mapped_column(ForeignKey(USERS_ID, ondelete=SET_NULL))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)


class StudentSelectionGroupMember(Base):
    __tablename__ = "student_selection_group_members"
    group_id: Mapped[int] = mapped_column(
        ForeignKey("student_selection_groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey(USERS_ID, ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (Index("idx_student_selection_group_members_user", "user_id", "group_id"),)


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


class Grade(Base):
    __tablename__ = "grades"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text("'ACTIVE'"))
    created_at: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[str] = mapped_column(Text)
    __table_args__ = (CheckConstraint("status IN ('ACTIVE','DISABLED')"),)


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
