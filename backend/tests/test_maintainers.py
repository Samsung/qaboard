from backend import maintainers, settings


def test_sizes_are_rough():
  assert maintainers.bucket(0) == "no"
  assert maintainers.bucket(1) == "up to 10"
  assert maintainers.bucket(11) == "up to 50"
  assert maintainers.bucket(1000) == "up to 1000"
  assert maintainers.bucket(1001) == "over 1000"
  assert maintainers.plural(1, 'user') == "up to 10 users"
  assert maintainers.plural(30, 'project') == "up to 50 projects"


def test_the_message_says_how_the_server_is_set_up_not_who_uses_it():
  facts = maintainers.server_facts(version="1.2.0", kubernetes=True, login_type="LOCAL", provider_types=["local", "oidc", "OIDC"],
                                   runner="kubernetes", users=42, projects=3)
  assert facts == [
    "QA-Board 1.2.0, on Kubernetes",
    "Sign-in: local, oidc",
    "Batches started from the web app: kubernetes",
    "Size: up to 50 users, up to 10 projects",
  ]
  body = maintainers.message_body(facts, "Ada Lovelace")
  assert body.startswith("Hi QA-Board maintainers,\n")
  assert "- Sign-in: local, oidc\n" in body
  assert "security fixes" in body and "new releases" in body
  assert body.endswith("Thanks,\nAda Lovelace\n")
  # without a name, no dangling line
  assert maintainers.message_body(facts, None).endswith("Thanks,\n")


def test_unknown_version_and_no_runner():
  facts = maintainers.server_facts(version=None, kubernetes=False, login_type="LDAP", provider_types=[], runner=None, users=0, projects=0)
  assert facts[0] == "QA-Board (version unknown), with Docker Compose or another way"
  assert facts[1] == "Sign-in: ldap"
  assert facts[2] == "Batches started from the web app: off"
  assert facts[3] == "Size: no users, no projects"


def test_admins_say_whether_they_wrote():
  definition = settings.DEFINITIONS['web.maintainers_contact']
  assert definition.choices == ('sent', 'dismissed') and definition.nullable and definition.default is None
  assert definition.env == 'QABOARD_MAINTAINERS_CONTACT'
