{{- define "qaboard.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "qaboard.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.version | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Usage: include "qaboard.selectorLabels" (list . "backend") */}}
{{- define "qaboard.selectorLabels" -}}
{{- $ := index . 0 -}}
app.kubernetes.io/name: {{ $.Chart.Name }}
app.kubernetes.io/instance: {{ $.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* Usage: include "qaboard.image" (list . "backend") */}}
{{- define "qaboard.image" -}}
{{- $ := index . 0 -}}
{{- $service := index . 1 -}}
{{- if $.Values.image.version -}}
{{ $.Values.image.repository }}:{{ $service }}-{{ $.Values.image.version }}
{{- else -}}
{{ $.Values.image.repository }}:{{ $service }}
{{- end -}}
{{- end -}}

{{- define "qaboard.secretName" -}}
{{- .Values.secret.existingSecret | default (printf "%s-secret" (include "qaboard.fullname" .)) -}}
{{- end -}}

{{- define "qaboard.dbHost" -}}
{{- if .Values.database.cnpg.enabled -}}
{{ include "qaboard.fullname" . }}-db-rw
{{- else if .Values.database.embedded.enabled -}}
{{ include "qaboard.fullname" . }}-db
{{- else -}}
{{ required "Set database.host, or enable database.cnpg or database.embedded" .Values.database.host }}
{{- end -}}
{{- end -}}

{{/* Environment shared by the backend, the migrations and flower */}}
{{- define "qaboard.backendEnv" -}}
- name: QABOARD_DB_HOST
  value: {{ include "qaboard.dbHost" . | quote }}
- name: QABOARD_DB_PORT
  value: {{ .Values.database.port | quote }}
- name: QABOARD_DB_NAME
  value: {{ .Values.database.name | quote }}
{{- if .Values.database.cnpg.enabled }}
# Created by CloudNativePG
- name: QABOARD_DB_USER
  valueFrom: {secretKeyRef: {name: {{ include "qaboard.fullname" . }}-db-app, key: username}}
- name: QABOARD_DB_PASSWORD
  valueFrom: {secretKeyRef: {name: {{ include "qaboard.fullname" . }}-db-app, key: password}}
{{- else }}
- name: QABOARD_DB_USER
  value: {{ .Values.database.user | quote }}
{{- if .Values.database.embedded.enabled }}
- name: QABOARD_DB_PASSWORD
  value: {{ .Values.database.embedded.password | quote }}
{{- end }}
{{- end }}
{{- if .Values.redis.enabled }}
- name: REDIS_HOST
  value: {{ include "qaboard.fullname" . }}-redis
- name: REDIS_PORT
  value: "6379"
{{- end }}
{{- if .Values.celery.enabled }}
- name: CELERY_BROKER_URL
  value: pyamqp://guest:guest@{{ include "qaboard.fullname" . }}-rabbitmq:5672//
{{- end }}
{{- with .Values.backend.env }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "qaboard.backendEnvFrom" -}}
- configMapRef:
    name: {{ include "qaboard.fullname" . }}-config
- secretRef:
    name: {{ include "qaboard.secretName" . }}
{{- end -}}
