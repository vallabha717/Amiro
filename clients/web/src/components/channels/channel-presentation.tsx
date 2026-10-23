"use client";

import {
  Bot,
  Hash,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  Send,
} from "lucide-react";
import { DiscordIcon } from "@/components/ui/discord-icon";

export function ChannelIcon({
  channelId,
  className,
}: {
  channelId: string | null | undefined;
  className?: string;
}) {
  switch (channelId?.toLowerCase()) {
    case "slack":
      return <Hash className={className} aria-hidden />;
    case "telegram":
      return <Send className={className} aria-hidden />;
    case "discord":
      return <DiscordIcon className={className} />;
    case "phone":
      return <Phone className={className} aria-hidden />;
    case "email":
      return <Mail className={className} aria-hidden />;
    case "whatsapp":
      return <MessageCircle className={className} aria-hidden />;
    case "a2a":
      return <Bot className={className} aria-hidden />;
    default:
      return <MessageSquare className={className} aria-hidden />;
  }
}

export function getChannelLabel(channelId: string | null | undefined): string {
  if (!channelId) return "Channel";
  switch (channelId.toLowerCase()) {
    case "slack":
      return "Slack";
    case "telegram":
      return "Telegram";
    case "discord":
      return "Discord";
    case "phone":
      return "Phone Calling";
    case "email":
      return "Email";
    case "whatsapp":
      return "WhatsApp";
    case "a2a":
      return "Assistant";
    default:
      return channelId.charAt(0).toUpperCase() + channelId.slice(1);
  }
}
