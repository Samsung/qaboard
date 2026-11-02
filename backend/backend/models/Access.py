"""
Who can do what on projects (docs/design/user-management.md, Appendix D): roles granted to users and groups, groups
and the sign-in claims that fill them, and the visibility of projects. The rules are in backend/access/.
"""
import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from backend.models import Base


class Group(Base):
  __tablename__ = 'groups'

  id = Column(Integer, primary_key=True)
  name = Column(String(), nullable=False, unique=True)
  description = Column(Text(), nullable=False, default='', server_default='')
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class GroupMember(Base):
  __tablename__ = 'group_members'
  __table_args__ = (UniqueConstraint('group_id', 'user_id', name='uq_group_members_group_user'),)

  id = Column(Integer, primary_key=True)
  group_id = Column(Integer, ForeignKey('groups.id', ondelete='CASCADE'), nullable=False, index=True)
  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
  user = relationship("User", foreign_keys=[user_id])
  # manual (added by an admin), rule (a sign-in claim matched one of the group's rules: replaced at each sign-in)
  source = Column(String(), nullable=False, default='manual', server_default='manual')
  added_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  added_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class GroupRule(Base):
  """Users join the group when they sign in with a claim among `values`, e.g. groups contains camera-team"""
  __tablename__ = 'group_rules'

  id = Column(Integer, primary_key=True)
  group_id = Column(Integer, ForeignKey('groups.id', ondelete='CASCADE'), nullable=False, index=True)
  # None: any sign-in method
  provider_id = Column(String(), nullable=True)
  # an OIDC claim, an LDAP or SAML attribute, or "email_domain"
  claim = Column(String(), nullable=False)
  values = Column(JSONB(), nullable=False, default=list, server_default='[]')
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class RoleGrant(Base):
  """A role on all projects (instance), or on a project and the projects under it (resource_id: an id or a prefix)"""
  __tablename__ = 'role_grants'
  __table_args__ = (UniqueConstraint('subject_type', 'subject_id', 'resource_type', 'resource_id', name='uq_role_grants_subject_resource'),)

  id = Column(Integer, primary_key=True)
  # user, group
  subject_type = Column(String(), nullable=False)
  subject_id = Column(Integer, nullable=False, index=True)
  # instance, project
  resource_type = Column(String(), nullable=False)
  # '' for the instance
  resource_id = Column(String(), nullable=False, default='', server_default='', index=True)
  # viewer, developer, owner
  role = Column(String(), nullable=False)
  # manual, request (an approved access request), import:yaml
  source = Column(String(), nullable=False, default='manual', server_default='manual')
  granted_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  granted_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  expires_at = Column(DateTime, nullable=True)


class ProjectVisibility(Base):
  """public, internal or private, for a project and the projects under it. The most restrictive along the path wins."""
  __tablename__ = 'project_visibility'

  path = Column(String(), primary_key=True)
  visibility = Column(String(), nullable=False)
  updated_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
