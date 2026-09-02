output "control_plane_public_ip" {
  value = aws_eip.control_plane_eip.public_ip
}